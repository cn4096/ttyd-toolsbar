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
    // modals
    modal: 'rename' | 'delete' | 'conflict' | null;
    modalFile: FileEntry | null;
    renameValue: string;
    // pending upload queue for conflict resolution
    pendingFiles: File[];
    pendingIdx: number;
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

export class FileManager extends Component<Props, State> {
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

    // ── API helpers ──────────────────────────────────────────

    private async loadDir(path: string) {
        this.setState({ loading: true, error: '', selected: null });
        try {
            const r = await fetch(`/files?path=${encodeURIComponent(path)}`);
            if (!r.ok) {
                const j = await r.json();
                this.setState({ error: j.error || 'Load failed', loading: false });
                return;
            }
            const data = await r.json();
            const files: FileEntry[] = (data.files as FileEntry[]).sort((a, b) => {
                if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
                return a.name.localeCompare(b.name);
            });
            this.setState({ files, path: data.path, loading: false });
        } catch (e) {
            this.setState({ error: String(e), loading: false });
        }
    }

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

    // ── Navigation ───────────────────────────────────────────

    private enter = (f: FileEntry) => {
        if (!f.isDir) return;
        const next = this.state.path === '/' ? `/${f.name}` : `${this.state.path}/${f.name}`;
        this.loadDir(next);
    };

    private navTo = (path: string) => {
        this.loadDir(path);
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

    // ── Download ─────────────────────────────────────────────

    private download = (f: FileEntry, e: MouseEvent) => {
        e.stopPropagation();
        const filePath = this.state.path === '/' ? `/${f.name}` : `${this.state.path}/${f.name}`;
        const a = document.createElement('a');
        a.href = `/file/download?path=${encodeURIComponent(filePath)}`;
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
        const filePath = path === '/' ? `/${modalFile.name}` : `${path}/${modalFile.name}`;
        const res = await this.apiPost('/file/delete', { path: filePath });
        if (res.error) {
            this.setState({ error: res.error });
        } else {
            this.loadDir(path);
        }
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
        const from = path === '/' ? `/${modalFile.name}` : `${path}/${modalFile.name}`;
        const to = path === '/' ? `/${renameValue.trim()}` : `${path}/${renameValue.trim()}`;
        const res = await this.apiPost('/file/rename', { from, to });
        if (res.error) {
            this.setState({ error: res.error });
        } else {
            this.loadDir(path);
        }
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
        // conflict check
        const exists = files.some(f => f.name === file.name);
        if (exists) {
            this.setState({ modal: 'conflict', pendingIdx });
        } else {
            this.doUpload(file, file.name);
        }
    }

    // User chose to overwrite
    private conflictOverwrite = () => {
        const { pendingFiles, pendingIdx } = this.state;
        const file = pendingFiles[pendingIdx];
        this.setState({ modal: null });
        this.doUpload(file, file.name);
    };

    // User chose to rename old file, then upload with original name
    private conflictRenameOld = async () => {
        const { pendingFiles, pendingIdx, path } = this.state;
        const file = pendingFiles[pendingIdx];
        this.setState({ modal: null });

        // Generate a unique name for the old file: name_20060102_150405.ext
        const now = new Date();
        const pad = (n: number) => String(n).padStart(2, '0');
        const ts = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}_${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
        const dot = file.name.lastIndexOf('.');
        const baseName = dot > 0 ? file.name.slice(0, dot) : file.name;
        const ext = dot > 0 ? file.name.slice(dot) : '';
        const newOldName = `${baseName}_${ts}${ext}`;

        const from = path === '/' ? `/${file.name}` : `${path}/${file.name}`;
        const to = path === '/' ? `/${newOldName}` : `${path}/${newOldName}`;
        await this.apiPost('/file/rename', { from, to });

        this.doUpload(file, file.name);
    };

    // Skip this file
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
            this.setState(
                {
                    error: `${file.name}: exceeds 30 MB limit`,
                    pendingIdx: pendingIdx + 1,
                },
                () => this.processNextUpload()
            );
            return;
        }

        const destPath = path === '/' ? `/${destName}` : `${path}/${destName}`;
        const xhr = new XMLHttpRequest();
        xhr.open('POST', `/file/upload?path=${encodeURIComponent(destPath)}`);

        this.setState({
            uploading: true,
            uploadLabel: `Uploading ${file.name}…`,
            uploadPct: 0,
        });

        xhr.upload.onprogress = ev => {
            if (ev.lengthComputable) {
                this.setState({ uploadPct: Math.round((ev.loaded / ev.total) * 100) });
            }
        };

        xhr.onload = () => {
            const nextIdx = pendingIdx + 1;
            this.setState(
                {
                    uploading: nextIdx < pendingFiles.length,
                    pendingIdx: nextIdx,
                },
                () => this.processNextUpload()
            );
        };

        xhr.onerror = () => {
            this.setState({
                error: `Upload failed: ${file.name}`,
                uploading: false,
                pendingFiles: [],
                pendingIdx: 0,
            });
        };

        /* send as raw octet-stream — backend writes bytes directly to file */
        xhr.setRequestHeader('Content-Type', 'application/octet-stream');
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
                                    <span onClick={() => this.navTo(c.path)}>{c.label}</span>
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
                            onClick={e => {
                                (e.currentTarget as HTMLButtonElement).previousElementSibling &&
                                    (
                                        (e.currentTarget as HTMLButtonElement)
                                            .previousElementSibling as HTMLInputElement
                                    ).click();
                            }}
                        >
                            ↑ Upload
                        </button>
                    </label>
                    <button onClick={() => this.loadDir(path)}>↻ Refresh</button>
                    {path !== '/' && (
                        <button
                            onClick={() => {
                                const parent = path.slice(0, path.lastIndexOf('/')) || '/';
                                this.navTo(parent);
                            }}
                        >
                            ↑ Up
                        </button>
                    )}
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
                                    onClick={() =>
                                        f.isDir
                                            ? this.enter(f)
                                            : this.setState({ selected: f.name === selected ? null : f.name })
                                    }
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

                {/* ── Modal: Rename ── */}
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

                {/* ── Modal: Delete ── */}
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

                {/* ── Modal: Conflict ── */}
                {modal === 'conflict' && conflictFile && (
                    <div class="fm-modal-overlay">
                        <div class="fm-modal">
                            <div class="fm-modal-title">File already exists</div>
                            <div class="fm-modal-msg">
                                <strong>{conflictFile.name}</strong> already exists in this directory. What would you
                                like to do?
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
