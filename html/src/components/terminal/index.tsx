import { bind } from 'decko';
import { Component, h } from 'preact';
import { Xterm, XtermOptions } from './xterm';

import '@xterm/xterm/css/xterm.css';
import { Modal } from '../modal';
import { ButtonBar } from '../buttonbar';
import { FileManager } from '../filemanager';

interface Props extends XtermOptions {
    id: string;
}

interface State {
    modal: boolean;
    activeTab: 'terminal' | 'files';
}

export class Terminal extends Component<Props, State> {
    private container: HTMLElement;
    private xterm: Xterm;

    constructor(props: Props) {
        super();
        this.xterm = new Xterm(props, this.showModal);
        this.state = { modal: false, activeTab: 'terminal' };
    }

    async componentDidMount() {
        await this.xterm.refreshToken();
        this.xterm.open(this.container);
        this.xterm.connect();
    }

    componentWillUnmount() {
        this.xterm.dispose();
    }

    render({ id }: Props, { modal, activeTab }: State) {
        return (
            <div id={id} style="display:flex;flex-direction:column;height:100%">
                <div
                    class="ttyd-terminal-area"
                    ref={(c: HTMLDivElement | null) => {
                        this.container = c as HTMLElement;
                    }}
                    style={`flex:1;min-height:0;overflow:hidden;display:${activeTab === 'terminal' ? 'block' : 'none'}`}
                />
                <FileManager visible={activeTab === 'files'} />
                <ButtonBar onSendCommand={this.sendCommand} activeTab={activeTab} onTabChange={this.handleTabChange} />
                <Modal show={modal}>
                    <label class="file-label">
                        <input onChange={this.sendFile} class="file-input" type="file" multiple />
                        <span class="file-cta">Choose files…</span>
                    </label>
                </Modal>
            </div>
        );
    }

    @bind
    showModal() {
        this.setState({ modal: true });
    }

    @bind
    sendCommand(command: string | Uint8Array) {
        this.xterm.sendData(command);
    }

    @bind
    handleTabChange(tab: 'terminal' | 'files') {
        this.setState({ activeTab: tab });
        if (tab === 'terminal') {
            // let xterm re-measure after layout change
            setTimeout(() => window.term && window.term.fit(), 50);
        }
    }

    @bind
    sendFile(event: Event) {
        this.setState({ modal: false });
        const files = (event.target as HTMLInputElement).files;
        if (files) this.xterm.sendFile(files);
    }
}
