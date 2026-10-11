// Projects and deployments: immutable, content-addressed site snapshots.
// Each deployment gets a preview URL (/d/<id>/); a project's production
// URL (/p/<name>/) points at one READY deployment and can be moved
// (promote / instant rollback) without re-uploading anything.
import { HttpError } from './http.js';
import { cleanPath, NAME_RE, RESERVED_NAMES } from './security.js';
import { buildSite } from './build.js';
import { mimeType } from './mime.js';

export const DEPLOY_LIMITS = {
  maxFiles: 2000,
  maxFileBytes: 10 * 1024 * 1024,
  maxTotalBytes: 50 * 1024 * 1024,
  maxProjectsPerUser: 50,
  keepDeployments: 30,
};

export class Deployments {
  constructor(store) {
    this.store = store;
  }

  get db() { return this.store.data; }

  project(name) {
    return Object.values(this.db.projects).find((p) => p.name === name) || null;
  }

  ownedProject(user, name) {
    const p = this.project(String(name || '').toLowerCase());
    // same error for "missing" and "not yours" so names can't be probed
    if (!p || p.ownerId !== user.id) throw new HttpError(404, 'project not found');
    return p;
  }

  createProject(user, rawName) {
    const name = String(rawName || '').toLowerCase();
    if (!NAME_RE.test(name)) throw new HttpError(400, 'project names use 1-40 lowercase letters, digits and dashes');
    if (RESERVED_NAMES.has(name)) throw new HttpError(400, `'${name}' is reserved`);
    if (this.project(name)) throw new HttpError(409, 'that project name is taken');
    const mine = Object.values(this.db.projects).filter((p) => p.ownerId === user.id).length;
    if (mine >= DEPLOY_LIMITS.maxProjectsPerUser) throw new HttpError(403, `limit of ${DEPLOY_LIMITS.maxProjectsPerUser} projects reached`);
    const project = {
      id: this.store.id('prj'),
      name,
      ownerId: user.id,
      createdAt: new Date().toISOString(),
      productionId: null,
    };
    this.db.projects[project.id] = project;
    this.store.save();
    return project;
  }

  deleteProject(project) {
    for (const d of Object.values(this.db.deployments)) if (d.projectId === project.id) delete this.db.deployments[d.id];
    delete this.db.projects[project.id];
    this.store.save();
    this.store.gcBlobs();
  }

  listDeployments(project) {
    return Object.values(this.db.deployments)
      .filter((d) => d.projectId === project.id)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  /** Validate uploaded files, store them, run the Pyre build, record the deployment. */
  create(user, project, rawFiles, { target = 'production', source = 'api' } = {}) {
    if (!Array.isArray(rawFiles) || !rawFiles.length) throw new HttpError(400, 'files must be a non-empty array');
    if (rawFiles.length > DEPLOY_LIMITS.maxFiles) throw new HttpError(413, `at most ${DEPLOY_LIMITS.maxFiles} files per deployment`);
    if (!['production', 'preview'].includes(target)) throw new HttpError(400, 'target must be production or preview');
    const files = new Map();
    let total = 0;
    for (const f of rawFiles) {
      if (!f || typeof f !== 'object') throw new HttpError(400, 'each file needs a path and data');
      const path = cleanPath(f.path);
      if (files.has(path)) throw new HttpError(400, `duplicate file ${path}`);
      if (typeof f.data !== 'string' || !/^[A-Za-z0-9+/]*={0,2}$/.test(f.data)) throw new HttpError(400, `${path}: data must be base64`);
      const buf = Buffer.from(f.data, 'base64');
      if (buf.length > DEPLOY_LIMITS.maxFileBytes) throw new HttpError(413, `${path} is larger than ${DEPLOY_LIMITS.maxFileBytes / 1024 / 1024} MB`);
      total += buf.length;
      if (total > DEPLOY_LIMITS.maxTotalBytes) throw new HttpError(413, `deployment is larger than ${DEPLOY_LIMITS.maxTotalBytes / 1024 / 1024} MB`);
      files.set(path, buf);
    }

    let config = { cleanUrls: true, spa: false };
    if (files.has('chroma.json')) {
      try {
        const c = JSON.parse(files.get('chroma.json').toString('utf8'));
        config = { cleanUrls: c.cleanUrls !== false, spa: c.spa === true };
      } catch {
        throw new HttpError(400, 'chroma.json is not valid JSON');
      }
    }

    const started = Date.now();
    const build = buildSite(files);
    for (const [p, buf] of build.outputs) files.set(p, buf);

    const manifest = {};
    for (const [p, buf] of files) manifest[p] = { hash: this.store.putBlob(buf), size: buf.length, type: mimeType(p) };

    const d = {
      id: this.store.id('dpl'),
      projectId: project.id,
      createdBy: user.id,
      createdAt: new Date().toISOString(),
      target,
      source,
      status: build.ok ? 'READY' : 'ERROR',
      config,
      files: manifest,
      fileCount: files.size,
      size: [...files.values()].reduce((s, b) => s + b.length, 0),
      functions: build.functions,
      buildMs: Date.now() - started,
      log: [
        { level: 'info', file: null, message: `received ${rawFiles.length} files (${(total / 1024).toFixed(1)} KB)` },
        ...build.log,
        { level: build.ok ? 'info' : 'error', file: null, message: build.ok ? `build succeeded in ${Date.now() - started} ms` : 'build failed; fix the errors above and deploy again' },
      ],
    };
    this.db.deployments[d.id] = d;
    if (build.ok && target === 'production') project.productionId = d.id;
    this.prune(project);
    this.store.save();
    return d;
  }

  promote(project, deploymentId) {
    const d = this.db.deployments[deploymentId];
    if (!d || d.projectId !== project.id) throw new HttpError(404, 'deployment not found');
    if (d.status !== 'READY') throw new HttpError(409, 'only READY deployments can be promoted');
    project.productionId = d.id;
    this.store.save();
    return d;
  }

  remove(project, deploymentId) {
    const d = this.db.deployments[deploymentId];
    if (!d || d.projectId !== project.id) throw new HttpError(404, 'deployment not found');
    if (project.productionId === d.id) throw new HttpError(409, 'promote another deployment before deleting the production one');
    delete this.db.deployments[d.id];
    this.store.save();
    this.store.gcBlobs();
  }

  prune(project) {
    const list = this.listDeployments(project);
    let removed = 0;
    for (const d of list.slice(DEPLOY_LIMITS.keepDeployments)) {
      if (d.id === project.productionId) continue;
      delete this.db.deployments[d.id];
      removed++;
    }
    if (removed) this.store.gcBlobs();
  }

  summary(d, project) {
    return {
      id: d.id,
      project: project ? project.name : undefined,
      createdAt: d.createdAt,
      target: d.target,
      source: d.source,
      status: d.status,
      production: project ? project.productionId === d.id : undefined,
      fileCount: d.fileCount,
      size: d.size,
      buildMs: d.buildMs,
      functions: d.functions.map((f) => f.name),
      url: `/d/${d.id}/`,
    };
  }
}
