import { h, Component } from 'preact';
import './filemanager.scss';

interface FileEntry {
    name: string;
    isDir: boolean;
    size: number;
    mtime: number;
}

interface Props {
    visible: boolean;
}

interface State {
    path: string;
    files: FileEntry[];
    loading: boolean;
    error: string;
    selected: string | null;
    dragOver: boolean;
    uploading: boolean;
    uploadLabel: string;
    uploadPct: number;
    modal: 'rename' | 'delete' | 'conflict' | 'edit' | 'newfile' | 'newdir' | null;
    modalFile: FileEntry | null;
    renameValue: string;
    editContent: string;
    editSaving: boolean;
    newName: string;
    pendingFiles: File[];
    pendingIdx: number;
}

// ── Path utilities ──────────────────────────────────────────
// Resolve a clean absolute path, collapsing .. and duplicate slashes.
// Always returns a path starting with / and no trailing slash (except root).
function resolvePath(base: string, rel: string): string {
    // build absolute input
    const abs = rel.startsWith('/') ? rel : `${base}/${rel}`;
    const parts = abs.split('/').filter(Boolean);
    const stack: string[] = [];
    for (const p of parts) {
        if (p === '..') {
            stack.pop();
        } else if (p !== '.') {
            stack.push(p);
        }
    }
    return '/' + stack.join('/');
}

// Join current path + child name into a clean absolute path
function joinPath(dir: string, name: string): string {
    return resolvePath(dir, name);
}

function fmtSize(bytes: number): string {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
    return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

function fmtDate(ts: number): string {
    return new Date(ts * 1000).toLocaleString();
}

// Tier 1: known text extensions — open directly, no sniff needed
const TEXT_EXTS = new Set([
    'txt',
    'md',
    'rst',
    'log',
    'sh',
    'bash',
    'zsh',
    'fish',
    'ksh',
    'py',
    'js',
    'ts',
    'tsx',
    'jsx',
    'mjs',
    'cjs',
    'json',
    'jsonc',
    'yaml',
    'yml',
    'toml',
    'ini',
    'cfg',
    'conf',
    'env',
    'html',
    'htm',
    'css',
    'scss',
    'sass',
    'less',
    'svg',
    'xml',
    'go',
    'c',
    'h',
    'cpp',
    'cc',
    'cxx',
    'hpp',
    'cs',
    'rs',
    'java',
    'kt',
    'swift',
    'rb',
    'php',
    'lua',
    'sql',
    'graphql',
    'proto',
    'csv',
    'tsv',
    'vue',
    'svelte',
    'dockerfile',
    'makefile',
    'gitignore',
    'gitattributes',
    'editorconfig',
    'npmrc',
    'nvmrc',
]);

// Tier 2: known binary extensions — reject immediately
const BINARY_EXTS = new Set([
    'png',
    'jpg',
    'jpeg',
    'gif',
    'bmp',
    'webp',
    'ico',
    'tiff',
    'avif',
    'mp3',
    'mp4',
    'wav',
    'ogg',
    'flac',
    'aac',
    'm4a',
    'avi',
    'mkv',
    'mov',
    'wmv',
    'flv',
    'webm',
    'zip',
    'gz',
    'bz2',
    'xz',
    'tar',
    'rar',
    '7z',
    'zst',
    'exe',
    'dll',
    'so',
    'dylib',
    'bin',
    'elf',
    'apk',
    'dmg',
    'pdf',
    'doc',
    'docx',
    'xls',
    'xlsx',
    'ppt',
    'pptx',
    'woff',
    'woff2',
    'ttf',
    'otf',
    'eot',
    'class',
    'pyc',
    'pyo',
    'o',
    'a',
    'lib',
    'db',
    'sqlite',
    'sqlite3',
]);

type TextCheckResult = 'text' | 'binary' | 'sniff';

function checkExtension(name: string): TextCheckResult {
    const dot = name.lastIndexOf('.');
    if (dot < 0) return 'sniff'; // no extension → sniff
    const ext = name.slice(dot + 1).toLowerCase();
    if (TEXT_EXTS.has(ext)) return 'text';
    if (BINARY_EXTS.has(ext)) return 'binary';
    return 'sniff'; // unknown extension → sniff
}

// Tier 3: sniff first 512 bytes
function sniffIsBinary(buf: Uint8Array): boolean {
    const len = Math.min(buf.length, 512);
    if (len === 0) return false;
    let nonPrint = 0;
    for (let i = 0; i < len; i++) {
        const b = buf[i];
        if (b === 0) return true; // null byte → binary
        if (b < 9 || (b > 13 && b < 32) || b === 127) nonPrint++;
    }
    return nonPrint / len > 0.3;
}

export class FileManager extends Component<Props, State> {
    private navSeq = 0;

    constructor(props: Props) {
        super(props);
        this.state = {
            path: '/',
            files: [],
            loading: false,
            error: '',
            selected: null,
            dragOver: false,
            uploading: false,
            uploadLabel: '',
            uploadPct: 0,
            modal: null,
            modalFile: null,
            renameValue: '',
            editContent: '',
            editSaving: false,
            newName: '',
            pendingFiles: [],
            pendingIdx: 0,
        };
    }

    componentDidMount() {
        this.loadDir('/');
    }

    componentDidUpdate(prevProps: Props) {
        if (!prevProps.visible && this.props.visible) {
            this.loadDir(this.state.path);
        }
    }

    // ── Navigation ───────────────────────────────────────────

    private async loadDir(target: string) {
        const path = resolvePath('/', target); // always clean absolute path
        const seq = ++this.navSeq;
        this.setState({ loading: true, error: '', selected: null, path });
        try {
            const r = await fetch(`/files?path=${encodeURIComponent(path)}`);
            if (seq !== this.navSeq) return;
            if (!r.ok) {
                const j = await r.json();
                this.setState({ error: j.error || 'Load failed', loading: false });
                return;
            }
            const data = await r.json();
            if (seq !== this.navSeq) return;
            const files: FileEntry[] = (data.files as FileEntry[]).sort((a, b) => {
                if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
                return a.name.localeCompare(b.name);
            });
            this.setState({ files, loading: false });
        } catch (e) {
            if (seq === this.navSeq) this.setState({ error: String(e), loading: false });
        }
    }

    private enterDir = (name: string) => {
        // use current state.path for joining — it's always clean because loadDir resolves it
        const next = joinPath(this.state.path, name);
        this.loadDir(next);
    };

    private navUp = () => {
        const next = resolvePath(this.state.path, '..');
        this.loadDir(next);
    };

    private buildCrumbs(): { label: string; path: string }[] {
        const parts = this.state.path.replace(/^\//, '').split('/').filter(Boolean);
        const crumbs = [{ label: '/', path: '/' }];
        let cur = '';
        for (const p of parts) {
            cur += `/${p}`;
            crumbs.push({ label: p, path: cur });
        }
        return crumbs;
    }

    // ── API helpers ──────────────────────────────────────────

    private async apiPost(url: string, body: object): Promise<{ ok?: boolean; error?: string }> {
        try {
            const r = await fetch(url, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(body),
            });
            return await r.json();
        } catch (e) {
            return { error: String(e) };
        }
    }

    // ── Download ─────────────────────────────────────────────

    private download = (f: FileEntry, e: MouseEvent) => {
        e.stopPropagation();
        const fp = joinPath(this.state.path, f.name);
        const a = document.createElement('a');
        a.href = `/file/download?path=${encodeURIComponent(fp)}`;
        a.download = f.name;
        a.click();
    };

    // ── Delete ───────────────────────────────────────────────

    private openDelete = (f: FileEntry, e: MouseEvent) => {
        e.stopPropagation();
        this.setState({ modal: 'delete', modalFile: f });
    };

    private confirmDelete = async () => {
        const { modalFile, path } = this.state;
        if (!modalFile) return;
        this.setState({ modal: null });
        const fp = joinPath(path, modalFile.name);
        const res = await this.apiPost('/file/delete', { path: fp });
        if (res.error) this.setState({ error: res.error });
        else this.loadDir(path);
    };

    // ── Rename ───────────────────────────────────────────────

    private openRename = (f: FileEntry, e: MouseEvent) => {
        e.stopPropagation();
        this.setState({ modal: 'rename', modalFile: f, renameValue: f.name });
    };

    private confirmRename = async () => {
        const { modalFile, renameValue, path } = this.state;
        if (!modalFile || !renameValue.trim()) return;
        this.setState({ modal: null });
        const from = joinPath(path, modalFile.name);
        const to = joinPath(path, renameValue.trim());
        const res = await this.apiPost('/file/rename', { from, to });
        if (res.error) this.setState({ error: res.error });
        else this.loadDir(path);
    };

    // ── Edit text file ───────────────────────────────────

    private openEdit = async (f: FileEntry, e: MouseEvent) => {
        e.stopPropagation();
        const tier = checkExtension(f.name);

        // Tier 2: known binary — reject immediately, no request needed
        if (tier === 'binary') {
            this.setState({ error: `${f.name}: binary file, cannot edit` });
            return;
        }

        const fp = joinPath(this.state.path, f.name);
        this.setState({ modal: 'edit', modalFile: f, editContent: '', editSaving: false });
        try {
            const r = await fetch(`/file/download?path=${encodeURIComponent(fp)}`);
            if (!r.ok) throw new Error(`HTTP ${r.status}`);

            if (tier === 'text') {
                // Tier 1: known text — decode directly, skip sniff
                const text = await r.text();
                this.setState({ editContent: text });
            } else {
                // Tier 3: unknown extension or no extension — sniff bytes
                const buf = await r.arrayBuffer();
                const bytes = new Uint8Array(buf);
                if (sniffIsBinary(bytes)) {
                    this.setState({ modal: null, error: `${f.name}: binary file, cannot edit` });
                    return;
                }
                const text = new TextDecoder('utf-8', { fatal: false }).decode(bytes);
                this.setState({ editContent: text });
            }
        } catch (err) {
            this.setState({ modal: null, error: `Failed to load: ${err}` });
        }
    };

    // ── New file / New folder ────────────────────────────────

    private openNew = (type: 'newfile' | 'newdir') => {
        this.setState({ modal: type, newName: '' });
    };

    private confirmNew = async () => {
        const { modal, newName, path } = this.state;
        const name = newName.trim();
        if (!name) return;
        this.setState({ modal: null });

        if (modal === 'newdir') {
            // create empty dir via rename trick: upload a placeholder then delete, or use mkdir API
            // simplest: POST /file/mkdir
            const res = await this.apiPost('/file/mkdir', { path: joinPath(path, name) });
            if (res.error) this.setState({ error: res.error });
            else this.loadDir(path);
        } else {
            // create empty file via upload with empty body
            const fp = joinPath(path, name);
            const xhr = new XMLHttpRequest();
            xhr.open('POST', `/file/upload?path=${encodeURIComponent(fp)}`);
            xhr.setRequestHeader('Content-Type', 'application/octet-stream');
            xhr.onloadend = () => {
                const ok = xhr.status === 0 || (xhr.status >= 200 && xhr.status < 300);
                if (ok) this.loadDir(path);
                else this.setState({ error: `Create failed: ${name}` });
            };
            xhr.send(new Blob([]));
        }
    };

    private saveEdit = async () => {
        const { modalFile, editContent, path } = this.state;
        if (!modalFile) return;
        this.setState({ editSaving: true });
        const fp = joinPath(path, modalFile.name);
        const blob = new Blob([editContent], { type: 'application/octet-stream' });
        const xhr = new XMLHttpRequest();
        xhr.open('POST', `/file/upload?path=${encodeURIComponent(fp)}`);
        xhr.setRequestHeader('Content-Type', 'application/octet-stream');
        xhr.onloadend = () => {
            const ok = xhr.status === 0 || (xhr.status >= 200 && xhr.status < 300);
            if (ok) {
                this.setState({ modal: null, editSaving: false });
                this.loadDir(path);
            } else {
                this.setState({ editSaving: false, error: 'Save failed' });
            }
        };
        xhr.send(blob);
    };

    // ── Upload ───────────────────────────────────────────────

    private handleDragOver = (e: DragEvent) => {
        e.preventDefault();
        this.setState({ dragOver: true });
    };

    private handleDragLeave = () => {
        this.setState({ dragOver: false });
    };

    private handleDrop = (e: DragEvent) => {
        e.preventDefault();
        this.setState({ dragOver: false });
        const files = Array.from(e.dataTransfer?.files ?? []);
        if (files.length > 0) this.startUploadQueue(files);
    };

    private handleFileInput = (e: Event) => {
        const files = Array.from((e.target as HTMLInputElement).files ?? []);
        if (files.length > 0) this.startUploadQueue(files);
        (e.target as HTMLInputElement).value = '';
    };

    private startUploadQueue(files: File[]) {
        this.setState({ pendingFiles: files, pendingIdx: 0 }, () => {
            this.processNextUpload();
        });
    }

    private processNextUpload() {
        const { pendingFiles, pendingIdx, path, files } = this.state;
        if (pendingIdx >= pendingFiles.length) {
            this.loadDir(path);
            return;
        }
        const file = pendingFiles[pendingIdx];
        const exists = files.some(f => f.name === file.name);
        if (exists) {
            this.setState({ modal: 'conflict', pendingIdx });
        } else {
            this.doUpload(file, file.name);
        }
    }

    private conflictOverwrite = () => {
        const { pendingFiles, pendingIdx } = this.state;
        this.setState({ modal: null });
        this.doUpload(pendingFiles[pendingIdx], pendingFiles[pendingIdx].name);
    };

    private conflictRenameOld = async () => {
        const { pendingFiles, pendingIdx, path } = this.state;
        const file = pendingFiles[pendingIdx];
        this.setState({ modal: null });

        const now = new Date();
        const pad = (n: number) => String(n).padStart(2, '0');
        const ymd = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}`;
        const hms = `${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
        const ts = `${ymd}_${hms}`;
        const dot = file.name.lastIndexOf('.');
        const base = dot > 0 ? file.name.slice(0, dot) : file.name;
        const ext = dot > 0 ? file.name.slice(dot) : '';
        const newOldName = `${base}_${ts}${ext}`;

        await this.apiPost('/file/rename', {
            from: joinPath(path, file.name),
            to: joinPath(path, newOldName),
        });
        this.doUpload(file, file.name);
    };

    private conflictSkip = () => {
        const { pendingFiles, pendingIdx, path } = this.state;
        const nextIdx = pendingIdx + 1;
        if (nextIdx >= pendingFiles.length) {
            this.setState({ modal: null, pendingFiles: [], pendingIdx: 0 });
            this.loadDir(path);
        } else {
            this.setState({ modal: null, pendingIdx: nextIdx }, () => {
                this.processNextUpload();
            });
        }
    };

    private doUpload(file: File, destName: string) {
        const { path, pendingFiles, pendingIdx } = this.state;
        const MAX = 30 * 1024 * 1024;
        if (file.size > MAX) {
            this.setState({ error: `${file.name}: exceeds 30 MB limit`, pendingIdx: pendingIdx + 1 }, () =>
                this.processNextUpload()
            );
            return;
        }

        const destPath = joinPath(path, destName);
        const xhr = new XMLHttpRequest();
        xhr.open('POST', `/file/upload?path=${encodeURIComponent(destPath)}`);
        xhr.setRequestHeader('Content-Type', 'application/octet-stream');

        this.setState({ uploading: true, uploadLabel: `Uploading ${file.name}…`, uploadPct: 0 });

        xhr.upload.onprogress = ev => {
            if (ev.lengthComputable) {
                const pct = Math.round((ev.loaded / ev.total) * 100);
                this.setState({
                    uploadPct: pct,
                    // Once all bytes are sent, the server still needs to flush
                    // the file and send its response. Show a different label so
                    // the user knows we're waiting for the server, not stuck.
                    uploadLabel: pct >= 100 ? `Waiting for server… ${file.name}` : `Uploading ${file.name}…`,
                });
            }
        };

        // onloadend fires for both success and network error
        // treat HTTP 2xx OR empty response (file written but connection closed) as success
        xhr.onloadend = () => {
            const ok = xhr.status === 0 || (xhr.status >= 200 && xhr.status < 300);
            if (ok) {
                const nextIdx = pendingIdx + 1;
                this.setState({ uploading: nextIdx < pendingFiles.length, pendingIdx: nextIdx }, () =>
                    this.processNextUpload()
                );
            } else {
                this.setState({
                    error: `Upload failed: ${file.name} (${xhr.status})`,
                    uploading: false,
                    pendingFiles: [],
                    pendingIdx: 0,
                });
            }
        };

        xhr.send(file);
    }

    // ── Render ───────────────────────────────────────────────

    render({ visible }: Props, state: State) {
        if (!visible) return null;

        const {
            path,
            files,
            loading,
            error,
            selected,
            dragOver,
            uploading,
            uploadLabel,
            uploadPct,
            modal,
            modalFile,
            renameValue,
            pendingFiles,
            pendingIdx,
        } = state;

        const crumbs = this.buildCrumbs();
        const conflictFile = modal === 'conflict' ? pendingFiles[pendingIdx] : null;
        const isRoot = path === '/';

        return (
            <div class="fm-wrap">
                {/* breadcrumb */}
                <div class="fm-crumb">
                    {crumbs.map((c, i) => {
                        const isLast = i === crumbs.length - 1;
                        return (
                            <span key={c.path}>
                                {i > 0 && <span class="sep">/</span>}
                                {isLast ? (
                                    <span class="crumb-cur">{c.label}</span>
                                ) : (
                                    <span onClick={() => this.loadDir(c.path)}>{c.label}</span>
                                )}
                            </span>
                        );
                    })}
                </div>

                {/* toolbar */}
                <div class="fm-toolbar">
                    <label>
                        <input type="file" multiple style="display:none" onChange={this.handleFileInput} />
                        <button
                            onClick={e =>
                                (
                                    (e.currentTarget as HTMLButtonElement).previousElementSibling as HTMLInputElement
                                ).click()
                            }
                        >
                            ↑ Upload
                        </button>
                    </label>
                    <button onClick={() => this.loadDir(path)}>↻ Refresh</button>
                    <button onClick={() => this.openNew('newfile')}>+ File</button>
                    <button onClick={() => this.openNew('newdir')}>+ Folder</button>
                    {!isRoot && <button onClick={this.navUp}>↑ Up</button>}
                    <span class="fm-spacer" />
                    {error && <span style="color:#f54235;font-size:11px">{error}</span>}
                    <span class="fm-status">{files.length} items</span>
                </div>

                {/* upload progress */}
                {uploading && (
                    <div class="fm-progress">
                        <div class="fm-prog-label">
                            {uploadLabel} {uploadPct}%
                        </div>
                        <div class="fm-prog-bar">
                            <div class="fm-prog-fill" style={{ width: `${uploadPct}%` }} />
                        </div>
                    </div>
                )}

                {/* file list */}
                <div class="fm-list">
                    <div
                        class={`fm-drop-zone${dragOver ? ' drag-over' : ''}`}
                        onDragOver={this.handleDragOver as (e: Event) => void}
                        onDragLeave={this.handleDragLeave}
                        onDrop={this.handleDrop as (e: Event) => void}
                    >
                        {loading ? (
                            <div class="fm-loading">
                                <div class="spinner" />
                                Loading…
                            </div>
                        ) : files.length === 0 ? (
                            <div class="fm-empty">Empty directory — drop files here to upload</div>
                        ) : (
                            files.map(f => (
                                <div
                                    key={f.name}
                                    class={`fm-row${selected === f.name ? ' selected' : ''}`}
                                    onClick={() => {
                                        if (f.isDir) {
                                            this.enterDir(f.name);
                                        } else {
                                            this.setState({ selected: f.name === selected ? null : f.name });
                                        }
                                    }}
                                >
                                    <span class="fm-icon">{f.isDir ? '📁' : '📄'}</span>
                                    <span class="fm-name" title={f.name}>
                                        {f.name}
                                    </span>
                                    <span class="fm-size">{f.isDir ? '—' : fmtSize(f.size)}</span>
                                    <span class="fm-mtime">{fmtDate(f.mtime)}</span>
                                    <span class="fm-acts">
                                        {!f.isDir && (
                                            <button class="fm-act" onClick={e => this.download(f, e as MouseEvent)}>
                                                ↓
                                            </button>
                                        )}
                                        {!f.isDir && (
                                            <button class="fm-act" onClick={e => this.openEdit(f, e as MouseEvent)}>
                                                ✏
                                            </button>
                                        )}
                                        <button class="fm-act" onClick={e => this.openRename(f, e as MouseEvent)}>
                                            ✎
                                        </button>
                                        <button class="fm-act del" onClick={e => this.openDelete(f, e as MouseEvent)}>
                                            ✕
                                        </button>
                                    </span>
                                </div>
                            ))
                        )}
                    </div>
                </div>

                {/* Modal: Rename */}
                {modal === 'rename' && modalFile && (
                    <div class="fm-modal-overlay" onClick={() => this.setState({ modal: null })}>
                        <div class="fm-modal" onClick={e => e.stopPropagation()}>
                            <div class="fm-modal-title">Rename</div>
                            <input
                                type="text"
                                value={renameValue}
                                autofocus
                                onInput={e => this.setState({ renameValue: (e.target as HTMLInputElement).value })}
                                onKeyDown={e => {
                                    if (e.key === 'Enter') this.confirmRename();
                                    if (e.key === 'Escape') this.setState({ modal: null });
                                }}
                            />
                            <div class="fm-modal-actions">
                                <button class="btn-cancel" onClick={() => this.setState({ modal: null })}>
                                    Cancel
                                </button>
                                <button class="btn-ok" onClick={this.confirmRename}>
                                    Rename
                                </button>
                            </div>
                        </div>
                    </div>
                )}

                {/* Modal: Delete */}
                {modal === 'delete' && modalFile && (
                    <div class="fm-modal-overlay" onClick={() => this.setState({ modal: null })}>
                        <div class="fm-modal" onClick={e => e.stopPropagation()}>
                            <div class="fm-modal-title">Delete</div>
                            <div class="fm-modal-msg">
                                Delete <strong>{modalFile.name}</strong>?
                                {modalFile.isDir && ' (directory must be empty)'}
                            </div>
                            <div class="fm-modal-actions">
                                <button class="btn-cancel" onClick={() => this.setState({ modal: null })}>
                                    Cancel
                                </button>
                                <button class="btn-danger" onClick={this.confirmDelete}>
                                    Delete
                                </button>
                            </div>
                        </div>
                    </div>
                )}

                {/* Modal: Edit text file */}
                {modal === 'edit' && modalFile && (
                    <div class="fm-modal-overlay">
                        <div class="fm-modal fm-modal-editor">
                            <div class="fm-modal-title">
                                ✏ {modalFile.name}
                                <span style="font-weight:400;font-size:11px;color:#555;margin-left:8px">
                                    {state.editSaving ? 'Saving…' : ''}
                                </span>
                            </div>
                            <textarea
                                class="fm-editor-textarea"
                                value={state.editContent}
                                spellcheck={false}
                                onInput={e => this.setState({ editContent: (e.target as HTMLTextAreaElement).value })}
                                onKeyDown={e => {
                                    if ((e.ctrlKey || e.metaKey) && e.key === 's') {
                                        e.preventDefault();
                                        this.saveEdit();
                                    }
                                    if (e.key === 'Escape') this.setState({ modal: null });
                                }}
                            />
                            <div class="fm-modal-actions">
                                <button class="btn-cancel" onClick={() => this.setState({ modal: null })}>
                                    Cancel
                                </button>
                                <button class="btn-ok" onClick={this.saveEdit} disabled={state.editSaving}>
                                    Save
                                </button>
                            </div>
                            <div class="fm-editor-tip">Ctrl+S to save · Esc to cancel</div>
                        </div>
                    </div>
                )}

                {/* Modal: New file / New folder */}
                {(modal === 'newfile' || modal === 'newdir') && (
                    <div class="fm-modal-overlay" onClick={() => this.setState({ modal: null })}>
                        <div class="fm-modal" onClick={e => e.stopPropagation()}>
                            <div class="fm-modal-title">{modal === 'newfile' ? '+ New file' : '+ New folder'}</div>
                            <input
                                type="text"
                                placeholder={modal === 'newfile' ? 'filename.txt' : 'folder-name'}
                                value={state.newName}
                                autofocus
                                onInput={e => this.setState({ newName: (e.target as HTMLInputElement).value })}
                                onKeyDown={e => {
                                    if (e.key === 'Enter') this.confirmNew();
                                    if (e.key === 'Escape') this.setState({ modal: null });
                                }}
                            />
                            <div class="fm-modal-actions">
                                <button class="btn-cancel" onClick={() => this.setState({ modal: null })}>
                                    Cancel
                                </button>
                                <button class="btn-ok" onClick={this.confirmNew}>
                                    Create
                                </button>
                            </div>
                        </div>
                    </div>
                )}

                {/* Modal: Conflict */}
                {modal === 'conflict' && conflictFile && (
                    <div class="fm-modal-overlay">
                        <div class="fm-modal">
                            <div class="fm-modal-title">File already exists</div>
                            <div class="fm-modal-msg">
                                <strong>{conflictFile.name}</strong> already exists. What would you like to do?
                            </div>
                            <div class="fm-modal-actions" style="flex-wrap:wrap;gap:6px">
                                <button class="btn-cancel" onClick={this.conflictSkip}>
                                    Skip
                                </button>
                                <button
                                    class="btn-cancel"
                                    style="background:#2a3a2a;color:#7dba7d"
                                    onClick={this.conflictRenameOld}
                                >
                                    Rename old → upload new
                                </button>
                                <button class="btn-danger" onClick={this.conflictOverwrite}>
                                    Overwrite
                                </button>
                            </div>
                        </div>
                    </div>
                )}
            </div>
        );
    }
}
