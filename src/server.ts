
// const net = require('net');
import * as net from 'net';

import { TextDecoder } from 'util';

const { Subject } = require('await-notify');


import { DebugRuntime } from'./debugRuntime';


export class JsonServer {

    constructor() {}

    public host: string;
    public port: number;
    public server: net.Server;
    public restOfLine: string = "";
    public debugRuntime: DebugRuntime;
    public socket: net.Socket;
    
    async makeServer(debugRuntime: DebugRuntime, host: string = '127.0.0.1', port: number = 0) {
        this.debugRuntime = debugRuntime;
        this.host = host;
        this.port = port;
        const _this = this;
        this.server = net.createServer((sock) => {
            // Add a 'data' event handler to this instance of socket
            sock.on('data', (data) => {
                // post data to a server so it can be saved and stuff
                // console.info(data.toString());
                this.handleData(data);
            });

            _this.socket = sock;
        });

        const serverReady = new Subject();
        this.server.listen(0, this.host, function () {
            serverReady.notify();
        });

        // this.socket.on('data', this.handleData);

        await serverReady.wait(1000);

        // const address = this.socket.address();
        const address = this.server.address();
        if (typeof address === 'string' || address === undefined) {
            this.port = 0;
        } else {
            this.port = address.port;
        }
    }

    handleData = (data: Buffer) => {
		const dec = new TextDecoder;
        var s = dec.decode(data);
        s = s.replace(/\r/g,''); //keep only \n as linebreak
        var lines = s.split('\n');

        if(lines.length > 0){
            lines[0] = this.restOfLine + lines[0];
        }

        // console.error(data.toString());

		for(var i = 0; i<lines.length - 1; i++){
            const j = JSON.parse(lines[i]);
            // this.debugRuntime.handleJson(j);
            // console.error("Json:", j);
            this.debugRuntime.handleJson2(j);
        }
        if(lines.length > 0){
            this.restOfLine = lines[lines.length - 1];
        }
    };
}


