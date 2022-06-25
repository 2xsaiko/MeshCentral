﻿/**
* @description MeshCentral MSTSC & SSH relay
* @author Ylian Saint-Hilaire & Bryan Roe
* @copyright Intel Corporation 2018-2022
* @license Apache-2.0
* @version v0.0.1
*/

/*jslint node: true */
/*jshint node: true */
/*jshint strict:false */
/*jshint -W097 */
/*jshint esversion: 6 */
"use strict";


/*
Protocol numbers
10 = RDP
11 = SSH-TERM
12 = VNC
13 = SSH-FILES
14 = Web-TCP
*/

// Protocol Numbers
const PROTOCOL_TERMINAL = 1;
const PROTOCOL_DESKTOP = 2;
const PROTOCOL_FILES = 5;
const PROTOCOL_AMTWSMAN = 100;
const PROTOCOL_AMTREDIR = 101;
const PROTOCOL_MESSENGER = 200;
const PROTOCOL_WEBRDP = 201;
const PROTOCOL_WEBSSH = 202;
const PROTOCOL_WEBSFTP = 203;
const PROTOCOL_WEBVNC = 204;

// Mesh Rights
const MESHRIGHT_EDITMESH = 0x00000001; // 1
const MESHRIGHT_MANAGEUSERS = 0x00000002; // 2
const MESHRIGHT_MANAGECOMPUTERS = 0x00000004; // 4
const MESHRIGHT_REMOTECONTROL = 0x00000008; // 8
const MESHRIGHT_AGENTCONSOLE = 0x00000010; // 16
const MESHRIGHT_SERVERFILES = 0x00000020; // 32
const MESHRIGHT_WAKEDEVICE = 0x00000040; // 64
const MESHRIGHT_SETNOTES = 0x00000080; // 128
const MESHRIGHT_REMOTEVIEWONLY = 0x00000100; // 256
const MESHRIGHT_NOTERMINAL = 0x00000200; // 512
const MESHRIGHT_NOFILES = 0x00000400; // 1024
const MESHRIGHT_NOAMT = 0x00000800; // 2048
const MESHRIGHT_DESKLIMITEDINPUT = 0x00001000; // 4096
const MESHRIGHT_LIMITEVENTS = 0x00002000; // 8192
const MESHRIGHT_CHATNOTIFY = 0x00004000; // 16384
const MESHRIGHT_UNINSTALL = 0x00008000; // 32768
const MESHRIGHT_NODESKTOP = 0x00010000; // 65536
const MESHRIGHT_REMOTECOMMAND = 0x00020000; // 131072
const MESHRIGHT_RESETOFF = 0x00040000; // 262144
const MESHRIGHT_GUESTSHARING = 0x00080000; // 524288
const MESHRIGHT_DEVICEDETAILS = 0x00100000; // 1048576
const MESHRIGHT_ADMIN = 0xFFFFFFFF;


// Construct a Web relay object
module.exports.CreateMultiWebRelay = function (parent, db, req, args, domain, userid, nodeid, addr, port) {
    const obj = {};
    obj.parent = parent;
    obj.lastOperation = Date.now();
    obj.domain = domain;
    obj.userid = userid;
    obj.nodeid = nodeid;
    obj.addr = addr;
    obj.port = port;
    var pendingRequests = [];
    var nextTunnelId = 1;
    var tunnels = {};

    // Any HTTP cookie set by the device is going to be shared between all tunnels to that device.
    obj.webCookie = null;

    // Events
    obj.closed = false;
    obj.onclose = null;

    // Handle new HTTP request
    obj.handleRequest = function (req, res) {
        //console.log('handleRequest', req.url);
        pendingRequests.push([req, res]);
        handleNextRequest();
    }

    // Handle request
    function handleNextRequest() {
        // Check to see if any of the tunnels are free
        var count = 0;
        for (var i in tunnels) {
            count += (tunnels[i].isWebSocket ? 0 : 1);
            if ((tunnels[i].relayActive == true) && (tunnels[i].res == null)) {
                // Found a free tunnel, use it
                //console.log('handleNextRequest-found empty tunnel');
                const x = pendingRequests.shift();
                tunnels[i].processRequest(x[0], x[1]);
                return;
            }
        }

        if (count > 0) return;

        // Launch a new tunnel
        //console.log('handleNextRequest-starting new tunnel');
        const tunnel = module.exports.CreateWebRelay(obj, db, args, domain);
        tunnel.onclose = function (tunnelId) { delete tunnels[tunnelId]; }
        tunnel.onconnect = function (tunnelId) { if (pendingRequests.length > 0) { const x = pendingRequests.shift(); tunnels[tunnelId].processRequest(x[0], x[1]); } }
        tunnel.oncompleted = function (tunnelId) { if (pendingRequests.length > 0) { const x = pendingRequests.shift(); tunnels[tunnelId].processRequest(x[0], x[1]); } }
        tunnel.connect(userid, nodeid, addr, port);
        tunnel.tunnelId = nextTunnelId++;
        tunnels[tunnel.tunnelId] = tunnel;
    }

    // Close all tunnels
    function close() {
        if (obj.closed == true) return;
        obj.closed = true;
        for (var i in tunnels) { tunnels[i].close(); }
        tunnels = null;
        if (obj.onclose) { obj.onclose(obj.userid + '/' + obj.multiTunnelId); }
        delete obj.userid;
        delete obj.lastOperation;
    }

    return obj;
}



// Construct a Web relay object
module.exports.CreateWebRelay = function (parent, db, args, domain) {
    //const Net = require('net');
    const WebSocket = require('ws')

    const obj = {};
    obj.relayActive = false;
    obj.closed = false;
    obj.isWebSocket = false;

    // Events
    obj.onclose = null;
    obj.oncompleted = null;
    obj.onconnect = null;

    // Process a HTTP request
    obj.processRequest = function (req, res) {
        if (obj.relayActive == false) { console.log("ERROR: Attempt to use an unconnected tunnel"); return false; }

        //console.log('processRequest-start', req.method);

        // Construct the HTTP request
        var request = req.method + ' ' + req.url + ' HTTP/' + req.httpVersion + '\r\n';
        request += 'host: ' + obj.addr + ':' + obj.port + '\r\n';
        const blockedHeaders = ['origin', 'host', 'cookie']; // These are headers we do not forward
        for (var i in req.headers) { if (blockedHeaders.indexOf(i) == -1) { request += i + ': ' + req.headers[i] + '\r\n'; } }
        if (parent.webCookie != null) { request += 'cookie: ' + parent.webCookie + '\r\n' } // If we have a sessin cookie, use it.
        request += '\r\n';

        //console.log('request', request);

        if ((req.headers['transfer-encoding'] != null) || (req.headers['content-length'] != null)) {
            // Read the HTTP body and send the request to the device
            obj.requestBinary = [Buffer.from(request)];
            req.on('data', function (data) { obj.requestBinary.push(data); });
            req.on('end', function () { obj.wsClient.send(Buffer.concat(obj.requestBinary)); delete obj.requestBinary; });
        } else {
            // Request has no body, send it now
            obj.wsClient.send(Buffer.from(request));
            //console.log('processRequest-sent-nobody');
        }
        obj.res = res;
    }

    // Disconnect
    obj.close = function (arg) {
        if (obj.closed == true) return;
        obj.closed = true;

        /*
        // Event the session ending
        if ((obj.startTime) && (obj.meshid != null)) {
            // Collect how many raw bytes where received and sent.
            // We sum both the websocket and TCP client in this case.
            var inTraffc = obj.ws._socket.bytesRead, outTraffc = obj.ws._socket.bytesWritten;
            if (obj.wsClient != null) { inTraffc += obj.wsClient._socket.bytesRead; outTraffc += obj.wsClient._socket.bytesWritten; }
            const sessionSeconds = Math.round((Date.now() - obj.startTime) / 1000);
            const user = parent.users[obj.cookie.userid];
            const username = (user != null) ? user.name : null;
            const event = { etype: 'relay', action: 'relaylog', domain: domain.id, nodeid: obj.nodeid, userid: obj.cookie.userid, username: username, sessionid: obj.sessionid, msgid: 123, msgArgs: [sessionSeconds, obj.sessionid], msg: "Left Web-SSH session \"" + obj.sessionid + "\" after " + sessionSeconds + " second(s).", protocol: PROTOCOL_WEBSSH, bytesin: inTraffc, bytesout: outTraffc };
            parent.DispatchEvent(['*', obj.nodeid, obj.cookie.userid, obj.meshid], obj, event);
            delete obj.startTime;
            delete obj.sessionid;
        }
        */
        if (obj.wsClient) {
            obj.wsClient.removeAllListeners('open');
            obj.wsClient.removeAllListeners('message');
            obj.wsClient.removeAllListeners('close');
            try { obj.wsClient.close(); } catch (ex) { console.log(ex); }
            delete obj.wsClient;
        }

        // Close any pending request
        if (obj.res) { obj.res.end(); delete obj.res; }

        // Event disconnection
        if (obj.onclose) { obj.onclose(obj.tunnelId); }

        obj.relayActive = false;
    };

    // Start the looppback server
    obj.connect = function (userid, nodeid, addr, port) {
        if (obj.relayActive || obj.closed) return;
        obj.addr = addr;
        obj.port = port;

        // Encode a cookie for the mesh relay
        const cookieContent = { userid: userid, domainid: domain.id, nodeid: nodeid, tcpport: port };
        if (addr != null) { cookieContent.tcpaddr = addr; }
        const cookie = parent.parent.encodeCookie(cookieContent, parent.parent.loginCookieEncryptionKey);

        try {
            // Setup the correct URL with domain and use TLS only if needed.
            const options = { rejectUnauthorized: false };
            const protocol = (args.tlsoffload) ? 'ws' : 'wss';
            var domainadd = '';
            if ((domain.dns == null) && (domain.id != '')) { domainadd = domain.id + '/' }
            const url = protocol + '://localhost:' + args.port + '/' + domainadd + (((obj.mtype == 3) && (obj.relaynodeid == null)) ? 'local' : 'mesh') + 'relay.ashx?p=14&auth=' + cookie; // Protocol 14 is Web-TCP
            parent.parent.debug('relay', 'TCP: Connection websocket to ' + url);
            obj.wsClient = new WebSocket(url, options);
            obj.wsClient.on('open', function () { parent.parent.debug('relay', 'TCP: Relay websocket open'); });
            obj.wsClient.on('message', function (data) { // Make sure to handle flow control.
                if (obj.relayActive == false) {
                    if ((data == 'c') || (data == 'cr')) {
                        obj.relayActive = true;
                        if (obj.onconnect) { obj.onconnect(obj.tunnelId); } // Event connection
                    }
                } else {
                    if (typeof data == 'string') {
                        // Forward any ping/pong commands to the browser
                        var cmd = null;
                        try { cmd = JSON.parse(data); } catch (ex) { }
                        if ((cmd != null) && (cmd.ctrlChannel == '102938') && (cmd.type == 'ping')) { cmd.type = 'pong'; obj.wsClient.send(JSON.stringify(cmd)); }
                        return;
                    }
                    // Relay WS --> TCP, event data coming in
                    processHttpData(data.toString('binary'));
                }
            });
            obj.wsClient.on('close', function () { parent.parent.debug('relay', 'TCP: Relay websocket closed'); obj.close(); });
            obj.wsClient.on('error', function (err) { parent.parent.debug('relay', 'TCP: Relay websocket error: ' + err); obj.close(); });
        } catch (ex) {
            console.log(ex);
        }
    }

    // Process incoming HTTP data
    obj.socketAccumulator = '';
    obj.socketParseState = 0;
    function processHttpData(data) {
        obj.socketAccumulator += data;
        while (true) {
            //console.log('ACC(' + obj.socketAccumulator + '): ' + obj.socketAccumulator);
            if (obj.socketParseState == 0) {
                var headersize = obj.socketAccumulator.indexOf('\r\n\r\n');
                if (headersize < 0) return;
                //obj.Debug("Header: "+obj.socketAccumulator.substring(0, headersize)); // Display received HTTP header
                obj.socketHeader = obj.socketAccumulator.substring(0, headersize).split('\r\n');
                obj.socketAccumulator = obj.socketAccumulator.substring(headersize + 4);
                obj.socketParseState = 1;
                obj.socketData = '';
                obj.socketXHeader = { Directive: obj.socketHeader[0].split(' ') };
                for (var i in obj.socketHeader) {
                    if (i != 0) {
                        var x2 = obj.socketHeader[i].indexOf(':');
                        obj.socketXHeader[obj.socketHeader[i].substring(0, x2).toLowerCase()] = obj.socketHeader[i].substring(x2 + 2);
                    }
                }
            }
            if (obj.socketParseState == 1) {
                var csize = -1;
                if ((obj.socketXHeader['connection'] != undefined) && (obj.socketXHeader['connection'].toLowerCase() == 'close') && ((obj.socketXHeader["transfer-encoding"] == undefined) || (obj.socketXHeader["transfer-encoding"].toLowerCase() != 'chunked'))) {
                    // The body ends with a close, in this case, we will only process the header
                    csize = 0;
                } else if (obj.socketXHeader['content-length'] != undefined) {
                    // The body length is specified by the content-length
                    csize = parseInt(obj.socketXHeader['content-length']);
                    if (obj.socketAccumulator.length < csize) return;
                    var data = obj.socketAccumulator.substring(0, csize);
                    obj.socketAccumulator = obj.socketAccumulator.substring(csize);
                    obj.socketData = data;
                    csize = 0;
                } else {
                    // The body is chunked
                    var clen = obj.socketAccumulator.indexOf('\r\n');
                    if (clen < 0) return; // Chunk length not found, exit now and get more data.
                    // Chunk length if found, lets see if we can get the data.
                    csize = parseInt(obj.socketAccumulator.substring(0, clen), 16);
                    if (obj.socketAccumulator.length < clen + 2 + csize + 2) return;
                    // We got a chunk with all of the data, handle the chunck now.
                    var data = obj.socketAccumulator.substring(clen + 2, clen + 2 + csize);
                    obj.socketAccumulator = obj.socketAccumulator.substring(clen + 2 + csize + 2);
                    try { obj.socketData += data; } catch (ex) { console.log(ex, typeof data, data.length); }
                }
                if (csize == 0) {
                    //obj.Debug("xxOnSocketData DONE: (" + obj.socketData.length + "): " + obj.socketData);
                    processHttpResponse(obj.socketXHeader, obj.socketData);
                    obj.socketParseState = 0;
                    obj.socketHeader = null;
                }
            }
        }
    }

    // This is a fully parsed HTTP response from the remote device
    function processHttpResponse(header, data) {
        //console.log('processHttpResponse', header);
        obj.res.status(parseInt(header.Directive[1])); // Set the status
        const blockHeaders = ['Directive' ]; // These are headers we do not forward
        for (var i in header) {
            if (i == 'set-cookie') { parent.webCookie = header[i]; } // Keep the cookie, don't forward it
            else if (blockHeaders.indexOf(i) == -1) { obj.res.set(i, header[i]); } // Set the headers if not blocked
        }
        obj.res.set('Content-Security-Policy', "default-src 'self' 'unsafe-inline' 'unsafe-eval' data: blob:;"); // Set an "allow all" policy, see if the can restrict this in the future
        obj.res.end(data, 'binary'); // Write the data
        delete obj.res;

        // Event completion
        if (obj.oncompleted) { obj.oncompleted(obj.tunnelId); }
    }

    // Send data thru the relay tunnel
    function send(data) {
        if (obj.relayActive = - false) return false;
        obj.wsClient.send(data);
        return true;
    }

    parent.parent.debug('relay', 'TCP: Request for web relay');
    return obj;
};


// Construct a MSTSC Relay object, called upon connection
// This implementation does not have TLS support
// This is a bit of a hack as we are going to run the RDP connection thru a loopback connection.
// If the "node-rdpjs-2" module supported passing a socket, we would do something different.
module.exports.CreateMstscRelay = function (parent, db, ws, req, args, domain) {
    const Net = require('net');
    const WebSocket = require('ws');

    const obj = {};
    obj.ws = ws;
    obj.tcpServerPort = 0;
    obj.relayActive = false;
    var rdpClient = null;

    parent.parent.debug('relay', 'RDP: Request for RDP relay (' + req.clientIp + ')');

    // Disconnect
    obj.close = function (arg) {
        if (obj.ws == null) return;

        // Event the session ending
        if ((obj.startTime) && (obj.meshid != null)) {
            // Collect how many raw bytes where received and sent.
            // We sum both the websocket and TCP client in this case.
            var inTraffc = obj.ws._socket.bytesRead, outTraffc = obj.ws._socket.bytesWritten;
            if (obj.wsClient != null) { inTraffc += obj.wsClient._socket.bytesRead; outTraffc += obj.wsClient._socket.bytesWritten; }
            const sessionSeconds = Math.round((Date.now() - obj.startTime) / 1000);
            const user = parent.users[obj.userid];
            const username = (user != null) ? user.name : null;
            const event = { etype: 'relay', action: 'relaylog', domain: domain.id, nodeid: obj.nodeid, userid: obj.userid, username: username, sessionid: obj.sessionid, msgid: 125, msgArgs: [sessionSeconds, obj.sessionid], msg: "Left Web-RDP session \"" + obj.sessionid + "\" after " + sessionSeconds + " second(s).", protocol: PROTOCOL_WEBRDP, bytesin: inTraffc, bytesout: outTraffc };
            parent.parent.DispatchEvent(['*', obj.nodeid, obj.userid, obj.meshid], obj, event);
            delete obj.startTime;
            delete obj.sessionid;
        }

        if (obj.wsClient) { obj.wsClient.close(); delete obj.wsClient; }
        if (obj.tcpServer) { obj.tcpServer.close(); delete obj.tcpServer; }
        if (rdpClient) { rdpClient.close(); rdpClient = null; }
        if ((arg == 1) || (arg == null)) { try { ws.close(); } catch (ex) { console.log(ex); } } // Soft close, close the websocket
        if (arg == 2) { try { ws._socket._parent.end(); } catch (ex) { console.log(ex); } } // Hard close, close the TCP socket
        obj.ws.removeAllListeners();
        obj.relayActive = false;

        delete obj.ws;
        delete obj.nodeid;
        delete obj.meshid;
        delete obj.userid;
    };

    // Start the looppback server
    function startTcpServer() {
        obj.tcpServer = new Net.Server();
        obj.tcpServer.listen(0, 'localhost', function () { obj.tcpServerPort = obj.tcpServer.address().port; startRdp(obj.tcpServerPort); });
        obj.tcpServer.on('connection', function (socket) {
            if (obj.relaySocket != null) {
                socket.close();
            } else {
                obj.relaySocket = socket;
                obj.relaySocket.pause();
                obj.relaySocket.on('data', function (chunk) { // Make sure to handle flow control.
                    if (obj.relayActive == true) { obj.relaySocket.pause(); obj.wsClient.send(chunk, function () { obj.relaySocket.resume(); }); }
                });
                obj.relaySocket.on('end', function () { obj.close(); });
                obj.relaySocket.on('error', function (err) { obj.close(); });

                // Setup the correct URL with domain and use TLS only if needed.
                const options = { rejectUnauthorized: false };
                const protocol = (args.tlsoffload) ? 'ws' : 'wss';
                var domainadd = '';
                if ((domain.dns == null) && (domain.id != '')) { domainadd = domain.id + '/' }
                const url = protocol + '://localhost:' + args.port + '/' + domainadd + (((obj.mtype == 3) && (obj.relaynodeid == null)) ? 'local' : 'mesh') + 'relay.ashx?p=10&auth=' + obj.infos.ip;  // Protocol 10 is Web-RDP
                parent.parent.debug('relay', 'RDP: Connection websocket to ' + url);
                obj.wsClient = new WebSocket(url, options);
                obj.wsClient.on('open', function () { parent.parent.debug('relay', 'RDP: Relay websocket open'); });
                obj.wsClient.on('message', function (data) { // Make sure to handle flow control.
                    if (obj.relayActive == false) {
                        if ((data == 'c') || (data == 'cr')) {
                            obj.relayActive = true;
                            obj.relaySocket.resume();
                        }
                    } else {
                        if (typeof data == 'string') {
                            // Forward any ping/pong commands to the browser
                            var cmd = null;
                            try { cmd = JSON.parse(data); } catch (ex) { }
                            if ((cmd != null) && (cmd.ctrlChannel == '102938')) {
                                if (cmd.type == 'ping') { send(['ping']); }
                                else if (cmd.type == 'pong') { send(['pong']); }
                            }
                            return;
                        }
                        obj.wsClient._socket.pause();
                        try {
                            obj.relaySocket.write(data, function () {
                                if (obj.wsClient && obj.wsClient._socket) { try { obj.wsClient._socket.resume(); } catch (ex) { console.log(ex); } }
                            });
                        } catch (ex) { console.log(ex); obj.close(); }
                    }
                });
                obj.wsClient.on('close', function () { parent.parent.debug('relay', 'RDP: Relay websocket closed'); obj.close(); });
                obj.wsClient.on('error', function (err) { parent.parent.debug('relay', 'RDP: Relay websocket error: ' + err); obj.close(); });
                obj.tcpServer.close();
                obj.tcpServer = null;
            }
        });
    }

    // Start the RDP client
    function startRdp(port) {
        parent.parent.debug('relay', 'RDP: Starting RDP client on loopback port ' + port);
        try {
            const args = {
                logLevel: 'NONE', // 'ERROR',
                domain: obj.infos.domain,
                userName: obj.infos.username,
                password: obj.infos.password,
                enablePerf: true,
                autoLogin: true,
                screen: obj.infos.screen,
                locale: obj.infos.locale,
            };
            if (obj.infos.options) {
                if (obj.infos.options.flags != null) { args.perfFlags = obj.infos.options.flags; delete obj.infos.options.flags; }
                if ((obj.infos.options.workingDir != null) && (obj.infos.options.workingDir != '')) { args.workingDir = obj.infos.options.workingDir; }
                if ((obj.infos.options.alternateShell != null) && (obj.infos.options.alternateShell != '')) { args.alternateShell = obj.infos.options.alternateShell; }
            }
            rdpClient = require('./rdp').createClient(args).on('connect', function () {
                send(['rdp-connect']);
                if ((typeof obj.infos.options == 'object') && (obj.infos.options.savepass == true)) { saveRdpCredentials(); } // Save the credentials if needed
                obj.sessionid = Buffer.from(parent.crypto.randomBytes(9), 'binary').toString('base64');
                obj.startTime = Date.now();

                // Event session start
                try {
                    const user = parent.users[obj.userid];
                    const username = (user != null) ? user.name : null;
                    const event = { etype: 'relay', action: 'relaylog', domain: domain.id, nodeid: obj.nodeid, userid: obj.userid, username: username, sessionid: obj.sessionid, msgid: 150, msgArgs: [obj.sessionid], msg: "Started Web-RDP session \"" + obj.sessionid + "\".", protocol: PROTOCOL_WEBRDP };
                    parent.parent.DispatchEvent(['*', obj.nodeid, obj.userid, obj.meshid], obj, event);
                } catch (ex) { console.log(ex); }
            }).on('bitmap', function (bitmap) {
                try { ws.send(bitmap.data); } catch (ex) { } // Send the bitmap data as binary
                delete bitmap.data;
                send(['rdp-bitmap', bitmap]); // Send the bitmap metadata seperately, without bitmap data.
            }).on('clipboard', function (content) {
                send(['rdp-clipboard', content]); // The clipboard data has changed
            }).on('pointer', function (cursorId, cursorStr) {
                if (cursorStr == null) { cursorStr = 'default'; }
                if (obj.lastCursorStrSent != cursorStr) {
                    obj.lastCursorStrSent = cursorStr;
                    //console.log('pointer', cursorStr);
                    send(['rdp-pointer', cursorStr]); // The mouse pointer has changed
                }
            }).on('close', function () {
                send(['rdp-close']); // This RDP session has closed
            }).on('error', function (err) {
                if (typeof err == 'string') { send(['rdp-error', err]); }
                if ((typeof err == 'object') && (err.err) && (err.code)) { send(['rdp-error', err.err, err.code]); }
            }).connect('localhost', obj.tcpServerPort);
        } catch (ex) {
            console.log('startRdpException', ex);
            obj.close();
        }
    }

    // Save RDP credentials into database
    function saveRdpCredentials() {
        if (domain.allowsavingdevicecredentials == false) return;
        parent.parent.db.Get(obj.nodeid, function (err, nodes) {
            if ((err != null) || (nodes == null) || (nodes.length != 1)) return;
            const node = nodes[0];
            if (node.rdp == null) { node.rdp = {}; }

            // Check if credentials are already set
            if ((typeof node.rdp[obj.userid] == 'object') && (node.rdp[obj.userid].d == obj.infos.domain) && (node.rdp[obj.userid].u == obj.infos.username) && (node.rdp[obj.userid].p == obj.infos.password)) return;

            // Clear up any existing credentials or credentials for users that don't exist anymore
            for (var i in node.rdp) { if (!i.startsWith('user/') || (parent.users[i] == null)) { delete node.rdp[i]; } }

            // Clear legacy credentials
            delete node.rdp.d;
            delete node.rdp.u;
            delete node.rdp.p;

            // Save the credentials
            node.rdp[obj.userid] = { d: obj.infos.domain, u: obj.infos.username, p: obj.infos.password };
            parent.parent.db.Set(node);

            // Event the node change
            const event = { etype: 'node', action: 'changenode', nodeid: obj.nodeid, domain: domain.id, userid: obj.userid, node: parent.CloneSafeNode(node), msg: "Changed RDP credentials" };
            if (parent.parent.db.changeStream) { event.noact = 1; } // If DB change stream is active, don't use this event to change the node. Another event will come.
            parent.parent.DispatchEvent(parent.CreateMeshDispatchTargets(node.meshid, [obj.nodeid]), obj, event);
        });
    }

    // When data is received from the web socket
    // RDP default port is 3389
    ws.on('message', function (data) {
        try {
            var msg = null;
            try { msg = JSON.parse(data); } catch (ex) { }
            if ((msg == null) || (typeof msg != 'object')) return;
            switch (msg[0]) {
                case 'infos': {
                    obj.infos = msg[1];

                    if (obj.infos.ip.startsWith('node/')) {
                        // Use the user session
                        obj.nodeid = obj.infos.ip;
                        obj.userid = req.session.userid;
                    } else {
                        // Decode the authentication cookie
                        obj.cookie = parent.parent.decodeCookie(obj.infos.ip, parent.parent.loginCookieEncryptionKey);
                        if ((obj.cookie == null) || (typeof obj.cookie.nodeid != 'string') || (typeof obj.cookie.userid != 'string')) { obj.close(); return; }
                        obj.nodeid = obj.cookie.nodeid;
                        obj.userid = obj.cookie.userid;
                    }

                    // Get node and rights
                    parent.GetNodeWithRights(domain, obj.userid, obj.nodeid, function (node, rights, visible) {
                        if (obj.ws == null) return; // obj has been cleaned up, just exit.
                        if ((node == null) || (visible == false) || ((rights & MESHRIGHT_REMOTECONTROL) == 0)) { obj.close(); return; }
                        if ((rights != MESHRIGHT_ADMIN) && ((rights & MESHRIGHT_REMOTEVIEWONLY) != 0)) { obj.viewonly = true; }
                        if ((rights != MESHRIGHT_ADMIN) && ((rights & MESHRIGHT_DESKLIMITEDINPUT) != 0)) { obj.limitedinput = true; }
                        obj.mtype = node.mtype; // Store the device group type
                        obj.meshid = node.meshid; // Store the MeshID

                        // Check if we need to relay thru a different agent
                        const mesh = parent.meshes[obj.meshid];
                        if (mesh && mesh.relayid) {
                            obj.relaynodeid = mesh.relayid;
                            obj.tcpaddr = node.host;

                            // Get the TCP port to use
                            var tcpport = 3389;
                            if ((obj.cookie != null) && (obj.cookie.tcpport != null)) { tcpport = obj.cookie.tcpport; } else { if (node.rdpport) { tcpport = node.rdpport } }

                            // Re-encode a cookie with a device relay
                            const cookieContent = { userid: obj.userid, domainid: domain.id, nodeid: mesh.relayid, tcpaddr: node.host, tcpport: tcpport };
                            obj.infos.ip = parent.parent.encodeCookie(cookieContent, parent.parent.loginCookieEncryptionKey);
                        } else if (obj.infos.ip.startsWith('node/')) {
                            // Encode a cookie with a device relay
                            const cookieContent = { userid: obj.userid, domainid: domain.id, nodeid: obj.nodeid, tcpport: node.rdpport ? node.rdpport : 3389 };
                            obj.infos.ip = parent.parent.encodeCookie(cookieContent, parent.parent.loginCookieEncryptionKey);
                        }

                        // Check if we have rights to the relayid device, does nothing if a relay is not used
                        checkRelayRights(parent, domain, obj.userid, obj.relaynodeid, function (allowed) {
                            if (obj.ws == null) return; // obj has been cleaned up, just exit.
                            if (allowed !== true) { parent.parent.debug('relay', 'RDP: Attempt to use un-authorized relay'); obj.close(); return; }

                            // Check if we need to load server stored credentials
                            if ((typeof obj.infos.options == 'object') && (obj.infos.options.useServerCreds == true)) {
                                // Check if RDP credentials exist
                                if ((domain.allowsavingdevicecredentials !== false) && (typeof node.rdp == 'object') && (typeof node.rdp[obj.userid] == 'object') && (typeof node.rdp[obj.userid].d == 'string') && (typeof node.rdp[obj.userid].u == 'string') && (typeof node.rdp[obj.userid].p == 'string')) {
                                    obj.infos.domain = node.rdp[obj.userid].d;
                                    obj.infos.username = node.rdp[obj.userid].u;
                                    obj.infos.password = node.rdp[obj.userid].p;
                                    startTcpServer();
                                } else {
                                    // No server credentials.
                                    obj.infos.domain = '';
                                    obj.infos.username = '';
                                    obj.infos.password = '';
                                    startTcpServer();
                                }
                            } else {
                                startTcpServer();
                            }
                        });
                    });
                    break;
                }
                case 'mouse': { if (rdpClient && (obj.viewonly != true)) { rdpClient.sendPointerEvent(msg[1], msg[2], msg[3], msg[4]); } break; }
                case 'wheel': { if (rdpClient && (obj.viewonly != true)) { rdpClient.sendWheelEvent(msg[1], msg[2], msg[3], msg[4]); } break; }
                case 'clipboard': { rdpClient.setClipboardData(msg[1]); break; }
                case 'scancode': {
                    if (obj.limitedinput == true) { // Limit keyboard input
                        var ok = false, k = msg[1];
                        if ((k >= 2) && (k <= 11)) { ok = true; } // Number keys 1 to 0
                        if ((k >= 16) && (k <= 25)) { ok = true; } // First keyboard row
                        if ((k >= 30) && (k <= 38)) { ok = true; } // Second keyboard row
                        if ((k >= 44) && (k <= 50)) { ok = true; } // Third keyboard row
                        if ((k == 14) || (k == 28)) { ok = true; } // Enter and backspace
                        if (ok == false) return;
                    }
                    if (rdpClient && (obj.viewonly != true)) { rdpClient.sendKeyEventScancode(msg[1], msg[2]); } break;
                }
                case 'unicode': { if (rdpClient && (obj.viewonly != true)) { rdpClient.sendKeyEventUnicode(msg[1], msg[2]); } break; }
                case 'utype': {
                    if (!rdpClient) return;
                    obj.utype = msg[1];
                    if (obj.utypetimer == null) {
                        obj.utypetimer = setInterval(function () {
                            if ((obj.utype == null) || (obj.utype.length == 0)) { clearInterval(obj.utypetimer); obj.utypetimer = null; return; }
                            var c = obj.utype.charCodeAt(0);
                            obj.utype = obj.utype.substring(1);
                            if (c == 13) return;
                            if (c == 10) { rdpClient.sendKeyEventScancode(28, true); rdpClient.sendKeyEventScancode(28, false); }
                            else { rdpClient.sendKeyEventUnicode(c, true); rdpClient.sendKeyEventUnicode(c, false); }
                        }, 5);
                    }
                    break;
                }
                case 'ping': { try { obj.wsClient.send('{"ctrlChannel":102938,"type":"ping"}'); } catch (ex) { } break; }
                case 'pong': { try { obj.wsClient.send('{"ctrlChannel":102938,"type":"pong"}'); } catch (ex) { } break; }
                case 'disconnect': { obj.close(); break; }
            }
        } catch (ex) {
            console.log('RdpMessageException', msg, ex);
            obj.close();
        }
    });

    // If error, do nothing
    ws.on('error', function (err) { parent.parent.debug('relay', 'RDP: Browser websocket error: ' + err); obj.close(); });

    // If the web socket is closed
    ws.on('close', function (req) { parent.parent.debug('relay', 'RDP: Browser websocket closed'); obj.close(); });

    // Send an object with flow control
    function send(obj) {
        try { rdpClient.bufferLayer.socket.pause(); } catch (ex) { }
        try { ws.send(JSON.stringify(obj), function () { try { rdpClient.bufferLayer.socket.resume(); } catch (ex) { } }); } catch (ex) { }
    }

    // We are all set, start receiving data
    ws._socket.resume();

    return obj;
};


// Construct a SSH Relay object, called upon connection
module.exports.CreateSshRelay = function (parent, db, ws, req, args, domain) {
    const Net = require('net');
    const WebSocket = require('ws');
    
    // SerialTunnel object is used to embed SSH within another connection.
    function SerialTunnel(options) {
        const obj = new require('stream').Duplex(options);
        obj.forwardwrite = null;
        obj.updateBuffer = function (chunk) { this.push(chunk); };
        obj._write = function (chunk, encoding, callback) { if (obj.forwardwrite != null) { obj.forwardwrite(chunk); } if (callback) callback(); }; // Pass data written to forward
        obj._read = function (size) { }; // Push nothing, anything to read should be pushed from updateBuffer()
        obj.destroy = function () { delete obj.forwardwrite; }
        return obj;
    }

    const obj = {};
    obj.ws = ws;
    obj.relayActive = false;

    // Disconnect
    obj.close = function (arg) {
        if (obj.ws == null) return;

        // Event the session ending
        if ((obj.startTime) && (obj.meshid != null)) {
            // Collect how many raw bytes where received and sent.
            // We sum both the websocket and TCP client in this case.
            var inTraffc = obj.ws._socket.bytesRead, outTraffc = obj.ws._socket.bytesWritten;
            if (obj.wsClient != null) { inTraffc += obj.wsClient._socket.bytesRead; outTraffc += obj.wsClient._socket.bytesWritten; }
            const sessionSeconds = Math.round((Date.now() - obj.startTime) / 1000);
            const user = parent.users[obj.cookie.userid];
            const username = (user != null) ? user.name : null;
            const event = { etype: 'relay', action: 'relaylog', domain: domain.id, nodeid: obj.nodeid, userid: obj.cookie.userid, username: username, sessionid: obj.sessionid, msgid: 123, msgArgs: [sessionSeconds, obj.sessionid], msg: "Left Web-SSH session \"" + obj.sessionid + "\" after " + sessionSeconds + " second(s).", protocol: PROTOCOL_WEBSSH, bytesin: inTraffc, bytesout: outTraffc };
            parent.parent.DispatchEvent(['*', obj.nodeid, obj.cookie.userid, obj.meshid], obj, event);
            delete obj.startTime;
            delete obj.sessionid;
        }

        if (obj.sshShell) {
            obj.sshShell.destroy();
            obj.sshShell.removeAllListeners('data');
            obj.sshShell.removeAllListeners('close');
            try { obj.sshShell.end(); } catch (ex) { console.log(ex); }
            delete obj.sshShell;
        }
        if (obj.sshClient) {
            obj.sshClient.destroy();
            obj.sshClient.removeAllListeners('ready');
            try { obj.sshClient.end(); } catch (ex) { console.log(ex); }
            delete obj.sshClient;
        }
        if (obj.wsClient) {
            obj.wsClient.removeAllListeners('open');
            obj.wsClient.removeAllListeners('message');
            obj.wsClient.removeAllListeners('close');
            try { obj.wsClient.close(); } catch (ex) { console.log(ex); }
            delete obj.wsClient;
        }

        if ((arg == 1) || (arg == null)) { try { ws.close(); } catch (ex) { console.log(ex); } } // Soft close, close the websocket
        if (arg == 2) { try { ws._socket._parent.end(); } catch (ex) { console.log(ex); } } // Hard close, close the TCP socket
        obj.ws.removeAllListeners();

        obj.relayActive = false;
        delete obj.termSize;
        delete obj.cookie;
        delete obj.nodeid;
        delete obj.meshid;
        delete obj.userid;
        delete obj.ws;
    };

    // Save SSH credentials into database
    function saveSshCredentials(keep) {
        if (((keep != 1) && (keep != 2)) || (domain.allowsavingdevicecredentials == false)) return;
        parent.parent.db.Get(obj.nodeid, function (err, nodes) {
            if ((err != null) || (nodes == null) || (nodes.length != 1)) return;
            const node = nodes[0];
            if (node.ssh == null) { node.ssh = {}; }

            // Check if credentials are the same
            //if ((typeof node.ssh[obj.userid] == 'object') && (node.ssh[obj.userid].u == obj.username) && (node.ssh[obj.userid].p == obj.password)) return; // TODO

            // Clear up any existing credentials or credentials for users that don't exist anymore
            for (var i in node.ssh) { if (!i.startsWith('user/') || (parent.users[i] == null)) { delete node.ssh[i]; } }

            // Clear legacy credentials
            delete node.ssh.u;
            delete node.ssh.p;
            delete node.ssh.k;
            delete node.ssh.kp;

            // Save the credentials
            if (obj.password != null) {
                node.ssh[obj.userid] = { u: obj.username, p: obj.password };
            } else if (obj.privateKey != null) {
                node.ssh[obj.userid] = { u: obj.username, k: obj.privateKey };
                if (keep == 2) { node.ssh[obj.userid].kp = obj.privateKeyPass; }
            } else return;
            parent.parent.db.Set(node);

            // Event the node change
            const event = { etype: 'node', action: 'changenode', nodeid: obj.nodeid, domain: domain.id, userid: obj.userid, node: parent.CloneSafeNode(node), msg: "Changed SSH credentials" };
            if (parent.parent.db.changeStream) { event.noact = 1; } // If DB change stream is active, don't use this event to change the node. Another event will come.
            parent.parent.DispatchEvent(parent.CreateMeshDispatchTargets(node.meshid, [obj.nodeid]), obj, event);
        });
    }

    // Start the looppback server
    function startRelayConnection() {
        try {
            // Setup the correct URL with domain and use TLS only if needed.
            const options = { rejectUnauthorized: false };
            const protocol = (args.tlsoffload) ? 'ws' : 'wss';
            var domainadd = '';
            if ((domain.dns == null) && (domain.id != '')) { domainadd = domain.id + '/' }
            const url = protocol + '://localhost:' + args.port + '/' + domainadd + (((obj.mtype == 3) && (obj.relaynodeid == null)) ? 'local' : 'mesh') + 'relay.ashx?p=11&auth=' + obj.xcookie; // Protocol 11 is Web-SSH
            parent.parent.debug('relay', 'SSH: Connection websocket to ' + url);
            obj.wsClient = new WebSocket(url, options);
            obj.wsClient.on('open', function () { parent.parent.debug('relay', 'SSH: Relay websocket open'); });
            obj.wsClient.on('message', function (data) { // Make sure to handle flow control.
                if (obj.relayActive == false) {
                    if ((data == 'c') || (data == 'cr')) {
                        obj.relayActive = true;

                        // Create a serial tunnel && SSH module
                        obj.ser = new SerialTunnel();
                        const Client = require('ssh2').Client;
                        obj.sshClient = new Client();
                        obj.sshClient.on('ready', function () { // Authentication was successful.
                            // If requested, save the credentials
                            saveSshCredentials(obj.keep);
                            obj.sessionid = Buffer.from(parent.crypto.randomBytes(9), 'binary').toString('base64');
                            obj.startTime = Date.now();

                            // Event start of session
                            try {
                                const user = parent.users[obj.cookie.userid];
                                const username = (user != null) ? user.name : null;
                                const event = { etype: 'relay', action: 'relaylog', domain: domain.id, nodeid: obj.nodeid, userid: user._id, username: user.name, msgid: 148, msgArgs: [obj.sessionid], msg: "Started Web-SSH session \"" + obj.sessionid + "\".", protocol: PROTOCOL_WEBSSH };
                                parent.parent.DispatchEvent(['*', obj.nodeid, user._id, obj.meshid], obj, event);
                            } catch (ex) { console.log(ex); }

                            obj.sshClient.shell(function (err, stream) { // Start a remote shell
                                if (err) { obj.close(); return; }
                                obj.sshShell = stream;
                                obj.sshShell.setWindow(obj.termSize.rows, obj.termSize.cols, obj.termSize.height, obj.termSize.width);
                                obj.sshShell.on('close', function () { obj.close(); });
                                obj.sshShell.on('data', function (data) { obj.ws.send('~' + data.toString()); });
                            });
                            obj.ws.send(JSON.stringify({ action: 'connected' }));
                        });
                        obj.sshClient.on('error', function (err) {
                            if (err.level == 'client-authentication') { try { obj.ws.send(JSON.stringify({ action: 'autherror' })); } catch (ex) { } }
                            if (err.level == 'client-timeout') { try { obj.ws.send(JSON.stringify({ action: 'sessiontimeout' })); } catch (ex) { } }
                            obj.close();
                        });

                        // Setup the serial tunnel, SSH ---> Relay WS
                        obj.ser.forwardwrite = function (data) { if ((data.length > 0) && (obj.wsClient != null)) { try { obj.wsClient.send(data); } catch (ex) { } } };

                        // Connect the SSH module to the serial tunnel
                        const connectionOptions = { sock: obj.ser }
                        if (typeof obj.username == 'string') { connectionOptions.username = obj.username; }
                        if (typeof obj.password == 'string') { connectionOptions.password = obj.password; }
                        if (typeof obj.privateKey == 'string') { connectionOptions.privateKey = obj.privateKey; }
                        if (typeof obj.privateKeyPass == 'string') { connectionOptions.passphrase = obj.privateKeyPass; }
                        try {
                            obj.sshClient.connect(connectionOptions);
                        } catch (ex) {
                            // Exception, this is generally because we did not provide proper credentials. Ask again.
                            obj.relayActive = false;
                            delete obj.sshClient;
                            delete obj.ser.forwardwrite;
                            obj.close();
                            return;
                        }

                        // We are all set, start receiving data
                        ws._socket.resume();
                    }
                } else {
                    if (typeof data == 'string') {
                        // Forward any ping/pong commands to the browser
                        var cmd = null;
                        try { cmd = JSON.parse(data); } catch (ex) { }
                        if ((cmd != null) && (cmd.ctrlChannel == '102938') && ((cmd.type == 'ping') || (cmd.type == 'pong'))) { obj.ws.send(data); }
                        return;
                    }

                    // Relay WS --> SSH
                    if ((data.length > 0) && (obj.ser != null)) { try { obj.ser.updateBuffer(data); } catch (ex) { console.log(ex); } }
                }
            });
            obj.wsClient.on('close', function () { parent.parent.debug('relay', 'SSH: Relay websocket closed'); obj.close(); });
            obj.wsClient.on('error', function (err) { parent.parent.debug('relay', 'SSH: Relay websocket error: ' + err); obj.close(); });
        } catch (ex) {
            console.log(ex);
        }
    }

    // When data is received from the web socket
    // SSH default port is 22
    ws.on('message', function (data) {
        try {
            if (typeof data != 'string') return;
            if (data[0] == '{') {
                // Control data
                var msg = null;
                try { msg = JSON.parse(data); } catch (ex) { }
                if ((msg == null) || (typeof msg != 'object')) return;
                if ((msg.ctrlChannel == '102938') && ((msg.type == 'ping') || (msg.type == 'pong'))) { try { obj.wsClient.send(data); } catch (ex) { } return; }
                if (typeof msg.action != 'string') return;
                switch (msg.action) {
                    case 'connect': {
                        if (msg.useexisting) {
                            // Check if we have SSH credentials for this device
                            parent.parent.db.Get(obj.cookie.nodeid, function (err, nodes) {
                                if ((err != null) || (nodes == null) || (nodes.length != 1)) return;
                                const node = nodes[0];
                                if ((domain.allowsavingdevicecredentials === false) || (node.ssh == null) || (typeof node.ssh != 'object') || (node.ssh[obj.userid] == null) || (typeof node.ssh[obj.userid].u != 'string') || ((typeof node.ssh[obj.userid].p != 'string') && (typeof node.ssh[obj.userid].k != 'string'))) {
                                    // Send a request for SSH authentication
                                    try { ws.send(JSON.stringify({ action: 'sshauth' })) } catch (ex) { }
                                } else if ((domain.allowsavingdevicecredentials !== false) && (node.ssh != null) && (typeof node.ssh[obj.userid].k == 'string') && (node.ssh[obj.userid].kp == null)) {
                                    // Send a request for SSH authentication with option for only the private key password
                                    obj.username = node.ssh[obj.userid].u;
                                    obj.privateKey = node.ssh[obj.userid].k;
                                    try { ws.send(JSON.stringify({ action: 'sshauth', askkeypass: true })) } catch (ex) { }
                                } else {
                                    // Use our existing credentials
                                    obj.termSize = msg;
                                    delete obj.keep;
                                    obj.username = node.ssh[obj.userid].u;
                                    if (typeof node.ssh[obj.userid].p == 'string') {
                                        obj.password = node.ssh[obj.userid].p;
                                    } else if (typeof node.ssh[obj.userid].k == 'string') {
                                        obj.privateKey = node.ssh[obj.userid].k;
                                        obj.privateKeyPass = node.ssh[obj.userid].kp;
                                    }
                                    startRelayConnection();
                                }
                            });
                        } else {
                            // Verify inputs
                            if ((typeof msg.username != 'string') || ((typeof msg.password != 'string') && (typeof msg.key != 'string'))) break;
                            if ((typeof msg.rows != 'number') || (typeof msg.cols != 'number') || (typeof msg.height != 'number') || (typeof msg.width != 'number')) break;

                            obj.termSize = msg;
                            if (msg.keep === true) { msg.keep = 1; } // If true, change to 1. For user/pass, 1 to store user/pass in db. For user/key/pass, 1 to store user/key in db, 2 to store everything in db.
                            obj.keep = msg.keep; // If set, keep store credentials on the server if the SSH tunnel connected succesfully.
                            obj.username = msg.username;
                            obj.password = msg.password;
                            obj.privateKey = msg.key;
                            obj.privateKeyPass = msg.keypass;
                            startRelayConnection();
                        }
                        break;
                    }
                    case 'connectKeyPass': {
                        // Verify inputs
                        if (typeof msg.keypass != 'string') break;

                        // Check if we have SSH credentials for this device
                        obj.privateKeyPass = msg.keypass;
                        obj.termSize = msg;
                        parent.parent.db.Get(obj.cookie.nodeid, function (err, nodes) {
                            if ((err != null) || (nodes == null) || (nodes.length != 1)) return;
                            const node = nodes[0];
                            if (node.ssh != null) {
                                obj.username = node.ssh.u;
                                obj.privateKey = node.ssh.k;
                                startRelayConnection();
                            }
                        });
                        break;
                    }
                    case 'resize': {
                        // Verify inputs
                        if ((typeof msg.rows != 'number') || (typeof msg.cols != 'number') || (typeof msg.height != 'number') || (typeof msg.width != 'number')) break;

                        obj.termSize = msg;
                        if (obj.sshShell != null) { obj.sshShell.setWindow(obj.termSize.rows, obj.termSize.cols, obj.termSize.height, obj.termSize.width); }
                        break;
                    }
                }
            } else if (data[0] == '~') {
                // Terminal data
                if (obj.sshShell != null) { obj.sshShell.write(data.substring(1)); }
            }
        } catch (ex) { obj.close(); }
    });

    // If error, do nothing
    ws.on('error', function (err) { parent.parent.debug('relay', 'SSH: Browser websocket error: ' + err); obj.close(); });

    // If the web socket is closed
    ws.on('close', function (req) { parent.parent.debug('relay', 'SSH: Browser websocket closed'); obj.close(); });

    parent.parent.debug('relay', 'SSH: Request for SSH relay (' + req.clientIp + ')');

    // Decode the authentication cookie
    obj.cookie = parent.parent.decodeCookie(req.query.auth, parent.parent.loginCookieEncryptionKey);
    if ((obj.cookie == null) || (obj.cookie.userid == null) || (parent.users[obj.cookie.userid] == null)) { obj.ws.send(JSON.stringify({ action: 'sessionerror' })); obj.close(); return; }
    obj.userid = obj.cookie.userid;

    // Get the meshid for this device
    parent.parent.db.Get(obj.cookie.nodeid, function (err, nodes) {
        if (obj.cookie == null) return; // obj has been cleaned up, just exit.
        if ((err != null) || (nodes == null) || (nodes.length != 1)) { parent.parent.debug('relay', 'SSH: Invalid device'); obj.close(); }
        const node = nodes[0];
        obj.nodeid = node._id; // Store the NodeID
        obj.meshid = node.meshid; // Store the MeshID
        obj.mtype = node.mtype; // Store the device group type

        // Check if we need to relay thru a different agent
        const mesh = parent.meshes[obj.meshid];
        if (mesh && mesh.relayid) {
            obj.relaynodeid = mesh.relayid;
            obj.tcpaddr = node.host;

            // Check if we have rights to the relayid device, does nothing if a relay is not used
            checkRelayRights(parent, domain, obj.cookie.userid, obj.relaynodeid, function (allowed) {
                if (obj.cookie == null) return; // obj has been cleaned up, just exit.
                if (allowed !== true) { parent.parent.debug('relay', 'SSH: Attempt to use un-authorized relay'); obj.close(); return; }

                // Re-encode a cookie with a device relay
                const cookieContent = { userid: obj.cookie.userid, domainid: obj.cookie.domainid, nodeid: mesh.relayid, tcpaddr: node.host, tcpport: obj.cookie.tcpport };
                obj.xcookie = parent.parent.encodeCookie(cookieContent, parent.parent.loginCookieEncryptionKey);
            });
        } else {
            obj.xcookie = req.query.auth;
        }
    });

    return obj;
};


// Construct a SSH Terminal Relay object, called upon connection
module.exports.CreateSshTerminalRelay = function (parent, db, ws, req, domain, user, cookie, args) {
    const Net = require('net');
    const WebSocket = require('ws');

    // SerialTunnel object is used to embed SSH within another connection.
    function SerialTunnel(options) {
        const obj = new require('stream').Duplex(options);
        obj.forwardwrite = null;
        obj.updateBuffer = function (chunk) { this.push(chunk); };
        obj._write = function (chunk, encoding, callback) { if (obj.forwardwrite != null) { obj.forwardwrite(chunk); } if (callback) callback(); }; // Pass data written to forward
        obj._read = function (size) { }; // Push nothing, anything to read should be pushed from updateBuffer()
        obj.destroy = function () { delete obj.forwardwrite; }
        return obj;
    }

    const obj = {};
    obj.ws = ws;
    obj.relayActive = false;

    parent.parent.debug('relay', 'SSH: Request for SSH terminal relay (' + req.clientIp + ')');

    // Disconnect
    obj.close = function (arg) {
        if (obj.ws == null) return;

        // Event the session ending
        if (obj.startTime) {
            // Collect how many raw bytes where received and sent.
            // We sum both the websocket and TCP client in this case.
            var inTraffc = obj.ws._socket.bytesRead, outTraffc = obj.ws._socket.bytesWritten;
            if (obj.wsClient != null) { inTraffc += obj.wsClient._socket.bytesRead; outTraffc += obj.wsClient._socket.bytesWritten; }
            const sessionSeconds = Math.round((Date.now() - obj.startTime) / 1000);
            const event = { etype: 'relay', action: 'relaylog', domain: domain.id, nodeid: obj.nodeid, userid: user._id, username: user.name, msgid: 123, msgArgs: [sessionSeconds, obj.sessionid], msg: "Left Web-SSH session \"" + obj.sessionid + "\" after " + sessionSeconds + " second(s).", protocol: PROTOCOL_WEBSSH, bytesin: inTraffc, bytesout: outTraffc };
            parent.parent.DispatchEvent(['*', obj.nodeid, user._id, obj.meshid], obj, event);
            delete obj.startTime;
            delete obj.sessionid;
        }

        if (obj.sshShell) {
            obj.sshShell.destroy();
            obj.sshShell.removeAllListeners('data');
            obj.sshShell.removeAllListeners('close');
            try { obj.sshShell.end(); } catch (ex) { console.log(ex); }
            delete obj.sshShell;
        }
        if (obj.sshClient) {
            obj.sshClient.destroy();
            obj.sshClient.removeAllListeners('ready');
            try { obj.sshClient.end(); } catch (ex) { console.log(ex); }
            delete obj.sshClient;
        }
        if (obj.wsClient) {
            obj.wsClient.removeAllListeners('open');
            obj.wsClient.removeAllListeners('message');
            obj.wsClient.removeAllListeners('close');
            try { obj.wsClient.close(); } catch (ex) { console.log(ex); }
            delete obj.wsClient;
        }

        if ((arg == 1) || (arg == null)) { try { ws.close(); } catch (ex) { console.log(ex); } } // Soft close, close the websocket
        if (arg == 2) { try { ws._socket._parent.end(); } catch (ex) { console.log(ex); } } // Hard close, close the TCP socket
        obj.ws.removeAllListeners();

        obj.relayActive = false;
        delete obj.termSize;
        delete obj.nodeid;
        delete obj.meshid;
        delete obj.ws;
    };

    // Save SSH credentials into device
    function saveSshCredentials(keep) {
        if (((keep != 1) && (keep != 2)) || (domain.allowsavingdevicecredentials == false)) return;
        parent.parent.db.Get(obj.nodeid, function (err, nodes) {
            if ((err != null) || (nodes == null) || (nodes.length != 1)) return;
            const node = nodes[0];
            if (node.ssh == null) { node.ssh = {}; }

            // Check if credentials are the same
            //if ((typeof node.ssh == 'object') && (node.ssh.u == obj.username) && (node.ssh.p == obj.password)) return; // TODO

            // Clear up any existing credentials or credentials for users that don't exist anymore
            for (var i in node.ssh) { if (!i.startsWith('user/') || (parent.users[i] == null)) { delete node.ssh[i]; } }

            // Clear legacy credentials
            delete node.ssh.u;
            delete node.ssh.p;
            delete node.ssh.k;
            delete node.ssh.kp;

            // Save the credentials
            if (obj.password != null) {
                node.ssh[user._id] = { u: obj.username, p: obj.password };
            } else if (obj.privateKey != null) {
                node.ssh[user._id] = { u: obj.username, k: obj.privateKey };
                if (keep == 2) { node.ssh[user._id].kp = obj.privateKeyPass; }
            } else return;
            parent.parent.db.Set(node);

            // Event the node change
            const event = { etype: 'node', action: 'changenode', nodeid: obj.nodeid, domain: domain.id, userid: user._id, username: user.name, node: parent.CloneSafeNode(node), msg: "Changed SSH credentials" };
            if (parent.parent.db.changeStream) { event.noact = 1; } // If DB change stream is active, don't use this event to change the node. Another event will come.
            parent.parent.DispatchEvent(parent.CreateMeshDispatchTargets(node.meshid, [obj.nodeid]), obj, event);
        });
    }


    // Start the looppback server
    function startRelayConnection(authCookie) {
        try {
            // Setup the correct URL with domain and use TLS only if needed.
            const options = { rejectUnauthorized: false };
            const protocol = (args.tlsoffload) ? 'ws' : 'wss';
            var domainadd = '';
            if ((domain.dns == null) && (domain.id != '')) { domainadd = domain.id + '/' }
            const url = protocol + '://localhost:' + args.port + '/' + domainadd + (((obj.mtype == 3) && (obj.relaynodeid == null)) ? 'local' : 'mesh') + 'relay.ashx?p=11&auth=' + authCookie // Protocol 11 is Web-SSH
            parent.parent.debug('relay', 'SSH: Connection websocket to ' + url);
            obj.wsClient = new WebSocket(url, options);
            obj.wsClient.on('open', function () { parent.parent.debug('relay', 'SSH: Relay websocket open'); });
            obj.wsClient.on('message', function (data) { // Make sure to handle flow control.
                if (obj.relayActive == false) {
                    if ((data == 'c') || (data == 'cr')) {
                        obj.relayActive = true;

                        // Create a serial tunnel && SSH module
                        obj.ser = new SerialTunnel();
                        const Client = require('ssh2').Client;
                        obj.sshClient = new Client();
                        obj.sshClient.on('ready', function () { // Authentication was successful.
                            // If requested, save the credentials
                            saveSshCredentials(obj.keep);
                            obj.sessionid = Buffer.from(parent.crypto.randomBytes(9), 'binary').toString('base64');
                            obj.startTime = Date.now();

                            try {
                                // Event start of session
                                const event = { etype: 'relay', action: 'relaylog', domain: domain.id, nodeid: obj.nodeid, userid: user._id, username: user.name, msgid: 148, msgArgs: [obj.sessionid], msg: "Started Web-SSH session \"" + obj.sessionid + "\".", protocol: PROTOCOL_WEBSSH };
                                parent.parent.DispatchEvent(['*', obj.nodeid, user._id, obj.meshid], obj, event);
                            } catch (ex) {
                                console.log(ex);
                            }

                            obj.sshClient.shell(function (err, stream) { // Start a remote shell
                                if (err) { obj.close(); return; }
                                obj.sshShell = stream;
                                obj.sshShell.setWindow(obj.termSize.rows, obj.termSize.cols, obj.termSize.height, obj.termSize.width);
                                obj.sshShell.on('close', function () { obj.close(); });
                                obj.sshShell.on('data', function (data) { obj.ws.send('~' + data.toString()); });
                            });

                            obj.connected = true;
                            obj.ws.send('c');
                        });
                        obj.sshClient.on('error', function (err) {
                            if (err.level == 'client-authentication') { try { obj.ws.send(JSON.stringify({ action: 'autherror' })); } catch (ex) { } }
                            if (err.level == 'client-timeout') { try { obj.ws.send(JSON.stringify({ action: 'sessiontimeout' })); } catch (ex) { } }
                            obj.close();
                        });

                        // Setup the serial tunnel, SSH ---> Relay WS
                        obj.ser.forwardwrite = function (data) { if ((data.length > 0) && (obj.wsClient != null)) { try { obj.wsClient.send(data); } catch (ex) { } } };

                        // Connect the SSH module to the serial tunnel
                        const connectionOptions = { sock: obj.ser }
                        if (typeof obj.username == 'string') { connectionOptions.username = obj.username; }
                        if (typeof obj.password == 'string') { connectionOptions.password = obj.password; }
                        if (typeof obj.privateKey == 'string') { connectionOptions.privateKey = obj.privateKey; }
                        if (typeof obj.privateKeyPass == 'string') { connectionOptions.passphrase = obj.privateKeyPass; }
                        try {
                            obj.sshClient.connect(connectionOptions);
                        } catch (ex) {
                            // Exception, this is generally because we did not provide proper credentials. Ask again.
                            obj.relayActive = false;
                            delete obj.sshClient;
                            delete obj.ser.forwardwrite;
                            try { ws.send(JSON.stringify({ action: 'sshauth', askkeypass: ((obj.username != null) && (obj.privateKey != null)) })) } catch (ex) { }
                        }

                        // We are all set, start receiving data
                        ws._socket.resume();
                    }
                } else {
                    if (typeof data == 'string') {
                        // Forward any ping/pong commands to the browser
                        var cmd = null;
                        try { cmd = JSON.parse(data); } catch (ex) { }
                        if ((cmd != null) && (cmd.ctrlChannel == '102938') && ((cmd.type == 'ping') || (cmd.type == 'pong'))) { try { obj.ws.send(data); } catch (ex) { console.log(ex); } }
                        return;
                    }

                    // Relay WS --> SSH
                    if ((data.length > 0) && (obj.ser != null)) { try { obj.ser.updateBuffer(data); } catch (ex) { console.log(ex); } }
                }
            });
            obj.wsClient.on('close', function () {
                if (obj.connected !== true) { try { obj.ws.send(JSON.stringify({ action: 'connectionerror' })); } catch (ex) { } }
                parent.parent.debug('relay', 'SSH: Relay websocket closed'); obj.close();
            });
            obj.wsClient.on('error', function (err) { parent.parent.debug('relay', 'SSH: Relay websocket error: ' + err); obj.close(); });
        } catch (ex) {
            console.log(ex);
        }
    }

    // When data is received from the web socket
    // SSH default port is 22
    ws.on('message', function (data) {
        try {
            if (typeof data != 'string') return;
            if (data[0] == '{') {
                // Control data
                var msg = null;
                try { msg = JSON.parse(data); } catch (ex) { }
                if ((msg == null) || (typeof msg != 'object')) return;
                if ((msg.ctrlChannel == '102938') && ((msg.type == 'ping') || (msg.type == 'pong'))) { try { obj.wsClient.send(data); } catch (ex) { } return; }
                switch (msg.action) {
                    case 'sshauth': {
                        // Verify inputs
                        if ((typeof msg.username != 'string') || ((typeof msg.password != 'string') && (typeof msg.key != 'string'))) break;
                        if ((typeof msg.rows != 'number') || (typeof msg.cols != 'number') || (typeof msg.height != 'number') || (typeof msg.width != 'number')) break;

                        if (msg.keep === true) { msg.keep = 1; } // If true, change to 1. For user/pass, 1 to store user/pass in db. For user/key/pass, 1 to store user/key in db, 2 to store everything in db.
                        obj.keep = msg.keep; // If set, keep store credentials on the server if the SSH tunnel connected succesfully.
                        obj.termSize = msg;
                        obj.username = msg.username;
                        obj.password = msg.password;
                        obj.privateKey = msg.key;
                        obj.privateKeyPass = msg.keypass;

                        // Create a mesh relay authentication cookie
                        const cookieContent = { userid: user._id, domainid: user.domain, nodeid: obj.nodeid, tcpport: obj.tcpport };
                        if (obj.relaynodeid) {
                            cookieContent.nodeid = obj.relaynodeid;
                            cookieContent.tcpaddr = obj.tcpaddr;
                        } else {
                            if (obj.mtype == 3) { cookieContent.lc = 1; } // This is a local device
                        }
                        startRelayConnection(parent.parent.encodeCookie(cookieContent, parent.parent.loginCookieEncryptionKey));
                        break;
                    }
                    case 'sshkeyauth': {
                        // Verify inputs
                        if (typeof msg.keypass != 'string') break;
                        if ((typeof msg.rows != 'number') || (typeof msg.cols != 'number') || (typeof msg.height != 'number') || (typeof msg.width != 'number')) break;

                        delete obj.keep;
                        obj.termSize = msg;
                        obj.privateKeyPass = msg.keypass;

                        // Create a mesh relay authentication cookie
                        const cookieContent = { userid: user._id, domainid: user.domain, nodeid: obj.nodeid, tcpport: obj.tcpport };
                        if (obj.relaynodeid) {
                            cookieContent.nodeid = obj.relaynodeid;
                            cookieContent.tcpaddr = obj.tcpaddr;
                        } else {
                            if (obj.mtype == 3) { cookieContent.lc = 1; } // This is a local device
                        }
                        startRelayConnection(parent.parent.encodeCookie(cookieContent, parent.parent.loginCookieEncryptionKey));
                        break;
                    }
                    case 'sshautoauth': {
                        // Verify inputs
                        if ((typeof msg.rows != 'number') || (typeof msg.cols != 'number') || (typeof msg.height != 'number') || (typeof msg.width != 'number')) break;
                        obj.termSize = msg;

                        if ((obj.username == null) || ((obj.password == null) && (obj.privateKey == null))) return;

                        // Create a mesh relay authentication cookie
                        const cookieContent = { userid: user._id, domainid: user.domain, nodeid: obj.nodeid, tcpport: obj.tcpport };
                        if (obj.relaynodeid) {
                            cookieContent.nodeid = obj.relaynodeid;
                            cookieContent.tcpaddr = obj.tcpaddr;
                        } else {
                            if (obj.mtype == 3) { cookieContent.lc = 1; } // This is a local device
                        }
                        startRelayConnection(parent.parent.encodeCookie(cookieContent, parent.parent.loginCookieEncryptionKey));
                        break;
                    }
                    case 'resize': {
                        // Verify inputs
                        if ((typeof msg.rows != 'number') || (typeof msg.cols != 'number') || (typeof msg.height != 'number') || (typeof msg.width != 'number')) break;

                        obj.termSize = msg;
                        if (obj.sshShell != null) { obj.sshShell.setWindow(obj.termSize.rows, obj.termSize.cols, obj.termSize.height, obj.termSize.width); }
                        break;
                    }
                }
            } else if (data[0] == '~') {
                // Terminal data
                if (obj.sshShell != null) { obj.sshShell.write(data.substring(1)); }
            }
        } catch (ex) { obj.close(); }
    });

    // If error, do nothing
    ws.on('error', function (err) { parent.parent.debug('relay', 'SSH: Browser websocket error: ' + err); obj.close(); });

    // If the web socket is closed
    ws.on('close', function (req) { parent.parent.debug('relay', 'SSH: Browser websocket closed'); obj.close(); });

    // Check that we have a user and nodeid
    if ((user == null) || (req.query.nodeid == null)) { obj.close(); return; } // Invalid nodeid
    parent.GetNodeWithRights(domain, user, req.query.nodeid, function (node, rights, visible) {
        if (obj.ws == null) return; // obj has been cleaned up, just exit.

        // Check permissions
        if ((rights & 8) == 0) { obj.close(); return; } // No MESHRIGHT_REMOTECONTROL rights
        if ((rights != 0xFFFFFFFF) && (rights & 0x00000200)) { obj.close(); return; } // MESHRIGHT_NOTERMINAL is set
        obj.mtype = node.mtype; // Store the device group type
        obj.nodeid = node._id; // Store the NodeID
        obj.meshid = node.meshid; // Store the MeshID

        // Check the SSH port
        obj.tcpport = 22;
        if (typeof node.sshport == 'number') { obj.tcpport = node.sshport; }

        // Check if we need to relay thru a different agent
        const mesh = parent.meshes[obj.meshid];
        if (mesh && mesh.relayid) { obj.relaynodeid = mesh.relayid; obj.tcpaddr = node.host; }

        // Check if we have rights to the relayid device, does nothing if a relay is not used
        checkRelayRights(parent, domain, user, obj.relaynodeid, function (allowed) {
            if (obj.ws == null) return; // obj has been cleaned up, just exit.
            if (allowed !== true) { parent.parent.debug('relay', 'SSH: Attempt to use un-authorized relay'); obj.close(); return; }

            // We are all set, start receiving data
            ws._socket.resume();

            // Check if we have SSH credentials for this device
            if ((domain.allowsavingdevicecredentials === false) || (node.ssh == null) || (typeof node.ssh != 'object') || (node.ssh[user._id] == null) || (typeof node.ssh[user._id].u != 'string') || ((typeof node.ssh[user._id].p != 'string') && (typeof node.ssh[user._id].k != 'string'))) {
                // Send a request for SSH authentication
                try { ws.send(JSON.stringify({ action: 'sshauth' })) } catch (ex) { }
            } else if ((typeof node.ssh[user._id].k == 'string') && (typeof node.ssh[user._id].kp != 'string')) {
                // Send a request for SSH authentication with option for only the private key password
                obj.username = node.ssh[user._id].u;
                obj.privateKey = node.ssh[user._id].k;
                try { ws.send(JSON.stringify({ action: 'sshauth', askkeypass: true })) } catch (ex) { }
            } else {
                // Use our existing credentials
                obj.username = node.ssh[user._id].u;
                if (typeof node.ssh[user._id].p == 'string') {
                    obj.password = node.ssh[user._id].p;
                } else if (typeof node.ssh[user._id].k == 'string') {
                    obj.privateKey = node.ssh[user._id].k;
                    obj.privateKeyPass = node.ssh[user._id].kp;
                }
                try { ws.send(JSON.stringify({ action: 'sshautoauth' })) } catch (ex) { }
            }
        });

    });

    return obj;
};



// Construct a SSH Files Relay object, called upon connection
module.exports.CreateSshFilesRelay = function (parent, db, ws, req, domain, user, cookie, args) {
    const Net = require('net');
    const WebSocket = require('ws');

    // SerialTunnel object is used to embed SSH within another connection.
    function SerialTunnel(options) {
        const obj = new require('stream').Duplex(options);
        obj.forwardwrite = null;
        obj.updateBuffer = function (chunk) { this.push(chunk); };
        obj._write = function (chunk, encoding, callback) { if (obj.forwardwrite != null) { obj.forwardwrite(chunk); } if (callback) callback(); }; // Pass data written to forward
        obj._read = function (size) { }; // Push nothing, anything to read should be pushed from updateBuffer()
        obj.destroy = function () { delete obj.forwardwrite; }
        return obj;
    }

    const obj = {};
    obj.ws = ws;
    obj.path = require('path');
    obj.relayActive = false;
    obj.firstMessage = true;

    parent.parent.debug('relay', 'SSH: Request for SSH files relay (' + req.clientIp + ')');

    // Disconnect
    obj.close = function (arg) {
        if (obj.ws == null) return;

        // Event the session ending
        if (obj.startTime) {
            // Collect how many raw bytes where received and sent.
            // We sum both the websocket and TCP client in this case.
            var inTraffc = obj.ws._socket.bytesRead, outTraffc = obj.ws._socket.bytesWritten;
            if (obj.wsClient != null) { inTraffc += obj.wsClient._socket.bytesRead; outTraffc += obj.wsClient._socket.bytesWritten; }
            const sessionSeconds = Math.round((Date.now() - obj.startTime) / 1000);
            const event = { etype: 'relay', action: 'relaylog', domain: domain.id, nodeid: obj.nodeid, userid: user._id, username: user.name, sessionid: obj.sessionid, msgid: 124, msgArgs: [sessionSeconds, obj.sessionid], msg: "Left Web-SFTP session \"" + obj.sessionid + "\" after " + sessionSeconds + " second(s).", protocol: PROTOCOL_WEBSFTP, bytesin: inTraffc, bytesout: outTraffc };
            parent.parent.DispatchEvent(['*', obj.nodeid, user._id, obj.meshid], obj, event);
            delete obj.startTime;
            delete obj.sessionid;
        }

        if (obj.sshClient) {
            obj.sshClient.destroy();
            obj.sshClient.removeAllListeners('ready');
            try { obj.sshClient.end(); } catch (ex) { console.log(ex); }
            delete obj.sshClient;
        }
        if (obj.wsClient) {
            obj.wsClient.removeAllListeners('open');
            obj.wsClient.removeAllListeners('message');
            obj.wsClient.removeAllListeners('close');
            try { obj.wsClient.close(); } catch (ex) { console.log(ex); }
            delete obj.wsClient;
        }

        if ((arg == 1) || (arg == null)) { try { ws.close(); } catch (ex) { console.log(ex); } } // Soft close, close the websocket
        if (arg == 2) { try { ws._socket._parent.end(); } catch (ex) { console.log(ex); } } // Hard close, close the TCP socket
        obj.ws.removeAllListeners();

        obj.relayActive = false;
        delete obj.sftp;
        delete obj.nodeid;
        delete obj.meshid;
        delete obj.ws;
    };

    // Save SSH credentials into device
    function saveSshCredentials(keep) {
        if (((keep != 1) && (keep != 2)) || (domain.allowsavingdevicecredentials == false)) return;
        parent.parent.db.Get(obj.nodeid, function (err, nodes) {
            if ((err != null) || (nodes == null) || (nodes.length != 1)) return;
            const node = nodes[0];
            if (node.ssh == null) { node.ssh = {}; }

            // Check if credentials are the same
            //if ((typeof node.ssh[obj.userid] == 'object') && (node.ssh[obj.userid].u == obj.username) && (node.ssh[obj.userid].p == obj.password)) return; // TODO

            // Clear up any existing credentials or credentials for users that don't exist anymore
            for (var i in node.ssh) { if (!i.startsWith('user/') || (parent.users[i] == null)) { delete node.ssh[i]; } }

            // Clear legacy credentials
            delete node.ssh.u;
            delete node.ssh.p;
            delete node.ssh.k;
            delete node.ssh.kp;

            // Save the credentials
            if (obj.password != null) {
                node.ssh[user._id] = { u: obj.username, p: obj.password };
            } else if (obj.privateKey != null) {
                node.ssh[user._id] = { u: obj.username, k: obj.privateKey };
                if (keep == 2) { node.ssh[user._id].kp = obj.privateKeyPass; }
            } else return;
            parent.parent.db.Set(node);

            // Event the node change
            const event = { etype: 'node', action: 'changenode', nodeid: obj.nodeid, domain: domain.id, userid: user._id, username: user.name, node: parent.CloneSafeNode(node), msg: "Changed SSH credentials" };
            if (parent.parent.db.changeStream) { event.noact = 1; } // If DB change stream is active, don't use this event to change the node. Another event will come.
            parent.parent.DispatchEvent(parent.CreateMeshDispatchTargets(node.meshid, [obj.nodeid]), obj, event);
        });
    }


    // Start the looppback server
    function startRelayConnection(authCookie) {
        try {
            // Setup the correct URL with domain and use TLS only if needed.
            const options = { rejectUnauthorized: false };
            const protocol = (args.tlsoffload) ? 'ws' : 'wss';
            var domainadd = '';
            if ((domain.dns == null) && (domain.id != '')) { domainadd = domain.id + '/' }
            const url = protocol + '://localhost:' + args.port + '/' + domainadd + (((obj.mtype == 3) && (obj.relaynodeid == null)) ? 'local' : 'mesh') + 'relay.ashx?p=13&auth=' + authCookie // Protocol 13 is Web-SSH-Files
            parent.parent.debug('relay', 'SSH: Connection websocket to ' + url);
            obj.wsClient = new WebSocket(url, options);
            obj.wsClient.on('open', function () { parent.parent.debug('relay', 'SSH: Relay websocket open'); });
            obj.wsClient.on('message', function (data) { // Make sure to handle flow control.
                if (obj.relayActive == false) {
                    if ((data == 'c') || (data == 'cr')) {
                        obj.relayActive = true;

                        // Create a serial tunnel && SSH module
                        obj.ser = new SerialTunnel();
                        const Client = require('ssh2').Client;
                        obj.sshClient = new Client();
                        obj.sshClient.on('ready', function () { // Authentication was successful.
                            // If requested, save the credentials
                            saveSshCredentials(obj.keep);
                            obj.sessionid = Buffer.from(parent.crypto.randomBytes(9), 'binary').toString('base64');
                            obj.startTime = Date.now();

                            // Event start of session
                            try {
                                const event = { etype: 'relay', action: 'relaylog', domain: domain.id, nodeid: obj.nodeid, userid: user._id, username: user.name, msgid: 149, msgArgs: [obj.sessionid], msg: "Started Web-SFTP session \"" + obj.sessionid + "\".", protocol: PROTOCOL_WEBSFTP };
                                parent.parent.DispatchEvent(['*', obj.nodeid, user._id, obj.meshid], obj, event);
                            } catch (ex) { console.log(ex); }

                            obj.sshClient.sftp(function (err, sftp) {
                                if (err) { obj.close(); return; }
                                obj.connected = true;
                                obj.sftp = sftp;
                                obj.ws.send('c');
                            });
                        });
                        obj.sshClient.on('error', function (err) {
                            if (err.level == 'client-authentication') { try { obj.ws.send(JSON.stringify({ action: 'autherror' })); } catch (ex) { } }
                            if (err.level == 'client-timeout') { try { obj.ws.send(JSON.stringify({ action: 'sessiontimeout' })); } catch (ex) { } }
                            obj.close();
                        });

                        // Setup the serial tunnel, SSH ---> Relay WS
                        obj.ser.forwardwrite = function (data) { if ((data.length > 0) && (obj.wsClient != null)) { try { obj.wsClient.send(data); } catch (ex) { } } };

                        // Connect the SSH module to the serial tunnel
                        const connectionOptions = { sock: obj.ser }
                        if (typeof obj.username == 'string') { connectionOptions.username = obj.username; }
                        if (typeof obj.password == 'string') { connectionOptions.password = obj.password; }
                        if (typeof obj.privateKey == 'string') { connectionOptions.privateKey = obj.privateKey; }
                        if (typeof obj.privateKeyPass == 'string') { connectionOptions.passphrase = obj.privateKeyPass; }
                        try {
                            obj.sshClient.connect(connectionOptions);
                        } catch (ex) {
                            // Exception, this is generally because we did not provide proper credentials. Ask again.
                            obj.relayActive = false;
                            delete obj.sshClient;
                            delete obj.ser.forwardwrite;
                            try { ws.send(JSON.stringify({ action: 'sshauth', askkeypass: ((obj.username != null) && (obj.privateKey != null)) })) } catch (ex) { }
                        }

                        // We are all set, start receiving data
                        ws._socket.resume();
                    }
                } else {
                    if (typeof data == 'string') {
                        // Forward any ping/pong commands to the browser
                        var cmd = null;
                        try { cmd = JSON.parse(data); } catch (ex) { }
                        if ((cmd != null) && (cmd.ctrlChannel == '102938') && ((cmd.type == 'ping') || (cmd.type == 'pong'))) { obj.ws.send(data); }
                        return;
                    }

                    // Relay WS --> SSH
                    if ((data.length > 0) && (obj.ser != null)) { try { obj.ser.updateBuffer(data); } catch (ex) { console.log(ex); } }
                }
            });
            obj.wsClient.on('close', function () {
                if (obj.connected !== true) { try { obj.ws.send(JSON.stringify({ action: 'connectionerror' })); } catch (ex) { } }
                parent.parent.debug('relay', 'SSH: Files relay websocket closed'); obj.close();
            });
            obj.wsClient.on('error', function (err) { parent.parent.debug('relay', 'SSH: Files relay websocket error: ' + err); obj.close(); });
        } catch (ex) {
            console.log(ex);
        }
    }

    // When data is received from the web socket
    // SSH default port is 22
    ws.on('message', function (data) {
        //if ((obj.firstMessage === true) && (msg != 5)) { obj.close(); return; } else { delete obj.firstMessage; }
        try {
            if (typeof data != 'string') {
                if (data[0] == 123) {
                    data = data.toString();
                } else if ((obj.sftp != null) && (obj.uploadHandle != null)) {
                    const off = (data[0] == 0) ? 1 : 0;
                    obj.sftp.write(obj.uploadHandle, data, off, data.length - off, obj.uploadPosition, function (err) {
                        if (err != null) {
                            obj.sftp.close(obj.uploadHandle, function () { });
                            try { obj.ws.send(Buffer.from(JSON.stringify({ action: 'uploaddone', reqid: obj.uploadReqid }))) } catch (ex) { }
                            delete obj.uploadHandle;
                            delete obj.uploadFullpath;
                            delete obj.uploadSize;
                            delete obj.uploadReqid;
                            delete obj.uploadPosition;
                        } else {
                            try { obj.ws.send(Buffer.from(JSON.stringify({ action: 'uploadack', reqid: obj.uploadReqid }))) } catch (ex) { }
                        }
                    });
                    obj.uploadPosition += (data.length - off);
                    return;
                }
            }
            if (data[0] == '{') {
                // Control data
                var msg = null;
                try { msg = JSON.parse(data); } catch (ex) { }
                if ((msg == null) || (typeof msg != 'object')) return;
                if ((msg.ctrlChannel == '102938') && ((msg.type == 'ping') || (msg.type == 'pong'))) { try { obj.wsClient.send(data); } catch (ex) { } return; }
                if (typeof msg.action != 'string') return;
                switch (msg.action) {
                    case 'ls': {
                        if (obj.sftp == null) return;
                        var requestedPath = msg.path;
                        if (requestedPath.startsWith('/') == false) { requestedPath = '/' + requestedPath; }
                        obj.sftp.readdir(requestedPath, function(err, list) {
                            if (err) { console.log(err); obj.close(); }
                            const r = { path: requestedPath, reqid: msg.reqid, dir: [] };
                            for (var i in list) {
                                const file = list[i];
                                if (file.longname[0] == 'd') { r.dir.push({ t: 2, n: file.filename, d: new Date(file.attrs.mtime * 1000).toISOString() }); }
                                else { r.dir.push({ t: 3, n: file.filename, d: new Date(file.attrs.mtime * 1000).toISOString(), s: file.attrs.size }); }
                            }
                            try { obj.ws.send(Buffer.from(JSON.stringify(r))) } catch (ex) { }
                        });
                        break;
                    }
                    case 'mkdir': {
                        if (obj.sftp == null) return;
                        var requestedPath = msg.path;
                        if (requestedPath.startsWith('/') == false) { requestedPath = '/' + requestedPath; }
                        obj.sftp.mkdir(requestedPath, function (err) { });

                        // Event the file delete
                        const targets = ['*', 'server-users'];
                        if (user.groups) { for (var i in user.groups) { targets.push('server-users:' + i); } }
                        parent.parent.DispatchEvent(targets, obj, { etype: 'node', action: 'agentlog', nodeid: obj.nodeid, userid: user._id, username: user.name, msgid: 44, msgArgs: [requestedPath], msg: 'Create folder: \"' + requestedPath + '\"', domain: domain.id });
                        break;
                    }
                    case 'rm': {
                        if (obj.sftp == null) return;
                        var requestedPath = msg.path;
                        if (requestedPath.startsWith('/') == false) { requestedPath = '/' + requestedPath; }
                        for (var i in msg.delfiles) {
                            const ul = obj.path.join(requestedPath, msg.delfiles[i]).split('\\').join('/');
                            obj.sftp.unlink(ul, function (err) { });
                            if (msg.rec === true) { obj.sftp.rmdir(ul + '/', function (err) { }); }

                            // Event the file delete
                            const targets = ['*', 'server-users'];
                            if (user.groups) { for (var i in user.groups) { targets.push('server-users:' + i); } }
                            parent.parent.DispatchEvent(targets, obj, { etype: 'node', action: 'agentlog', nodeid: obj.nodeid, userid: user._id, username: user.name, msgid: 45, msgArgs: [ul], msg: 'Delete: \"' + ul + '\"', domain: domain.id });
                        }

                        break;
                    }
                    case 'rename': {
                        if (obj.sftp == null) return;
                        var requestedPath = msg.path;
                        if (requestedPath.startsWith('/') == false) { requestedPath = '/' + requestedPath; }
                        const oldpath = obj.path.join(requestedPath, msg.oldname).split('\\').join('/');
                        const newpath = obj.path.join(requestedPath, msg.newname).split('\\').join('/');
                        obj.sftp.rename(oldpath, newpath, function (err) { });

                        // Event the file rename
                        const targets = ['*', 'server-users'];
                        if (user.groups) { for (var i in user.groups) { targets.push('server-users:' + i); } }
                        parent.parent.DispatchEvent(targets, obj, { etype: 'node', action: 'agentlog', nodeid: obj.nodeid, userid: user._id, username: user.name, msgid: 48, msgArgs: [oldpath, msg.newname], msg: 'Rename: \"' + oldpath + '\" to \"' + msg.newname + '\"', domain: domain.id });
                        break;
                    }
                    case 'upload': {
                        if (obj.sftp == null) return;
                        var requestedPath = msg.path;
                        if (requestedPath.startsWith('/') == false) { requestedPath = '/' + requestedPath; }
                        obj.uploadFullpath = obj.path.join(requestedPath, msg.name).split('\\').join('/');
                        obj.uploadSize = msg.size;
                        obj.uploadReqid = msg.reqid;
                        obj.uploadPosition = 0;
                        obj.sftp.open(obj.uploadFullpath, 'w', 0o666, function (err, handle) {
                            if (err != null) {
                                try { obj.ws.send(Buffer.from(JSON.stringify({ action: 'uploaderror', reqid: obj.uploadReqid }))) } catch (ex) { }
                            } else {
                                obj.uploadHandle = handle;
                                try { obj.ws.send(Buffer.from(JSON.stringify({ action: 'uploadstart', reqid: obj.uploadReqid }))) } catch (ex) { }

                                // Event the file upload
                                const targets = ['*', 'server-users'];
                                if (user.groups) { for (var i in user.groups) { targets.push('server-users:' + i); } }
                                parent.parent.DispatchEvent(targets, obj, { etype: 'node', action: 'agentlog', nodeid: obj.nodeid, userid: user._id, username: user.name, msgid: 105, msgArgs: [obj.uploadFullpath, obj.uploadSize], msg: 'Upload: ' + obj.uploadFullpath + ', Size: ' + obj.uploadSize, domain: domain.id });
                            }
                        });
                        break;
                    }
                    case 'uploaddone': {
                        if (obj.sftp == null) return;
                        if (obj.uploadHandle != null) {
                            obj.sftp.close(obj.uploadHandle, function () { });
                            try { obj.ws.send(Buffer.from(JSON.stringify({ action: 'uploaddone', reqid: obj.uploadReqid }))) } catch (ex) { }
                            delete obj.uploadHandle;
                            delete obj.uploadFullpath;
                            delete obj.uploadSize;
                            delete obj.uploadReqid;
                            delete obj.uploadPosition;
                        }
                        break;
                    }
                    case 'uploadcancel': {
                        if (obj.sftp == null) return;
                        if (obj.uploadHandle != null) {
                            obj.sftp.close(obj.uploadHandle, function () { });
                            obj.sftp.unlink(obj.uploadFullpath, function (err) { });
                            try { obj.ws.send(Buffer.from(JSON.stringify({ action: 'uploadcancel', reqid: obj.uploadReqid }))) } catch (ex) { }
                            delete obj.uploadHandle;
                            delete obj.uploadFullpath;
                            delete obj.uploadSize;
                            delete obj.uploadReqid;
                            delete obj.uploadPosition;
                        }
                        break;
                    }
                    case 'download': {
                        if (obj.sftp == null) return;
                        switch (msg.sub) {
                            case 'start': {
                                var requestedPath = msg.path;
                                if (requestedPath.startsWith('/') == false) { requestedPath = '/' + requestedPath; }
                                obj.downloadFullpath = requestedPath;
                                obj.downloadId = msg.id;
                                obj.downloadPosition = 0;
                                obj.downloadBuffer = Buffer.alloc(16384);
                                obj.sftp.open(obj.downloadFullpath, 'r', function (err, handle) {
                                    if (err != null) {
                                        try { obj.ws.send(Buffer.from(JSON.stringify({ action: 'download', sub: 'cancel', id: obj.downloadId }))) } catch (ex) { }
                                    } else {
                                        obj.downloadHandle = handle;
                                        try { obj.ws.send(JSON.stringify({ action: 'download', sub: 'start', id: obj.downloadId })) } catch (ex) { }

                                        // Event the file download
                                        const targets = ['*', 'server-users'];
                                        if (user.groups) { for (var i in user.groups) { targets.push('server-users:' + i); } }
                                        parent.parent.DispatchEvent(targets, obj, { etype: 'node', action: 'agentlog', nodeid: obj.nodeid, userid: user._id, username: user.name, msgid: 49, msgArgs: [obj.downloadFullpath], msg: 'Download: ' + obj.downloadFullpath, domain: domain.id });
                                    }
                                });
                                break;
                            }
                            case 'startack': {
                                if ((obj.downloadHandle == null) || (obj.downloadId != msg.id)) break;
                                obj.downloadPendingBlockCount = (typeof msg.ack == 'number') ? msg.ack : 8;
                                uploadNextBlock();
                                break;
                            }
                            case 'ack': {
                                if ((obj.downloadHandle == null) || (obj.downloadId != msg.id)) break;
                                if (obj.downloadPendingBlockCount == 0) { obj.downloadPendingBlockCount = 1; uploadNextBlock(); }
                                break;
                            }
                            case 'stop': {
                                if ((obj.downloadHandle == null) || (obj.downloadId != msg.id)) break;
                                if (obj.downloadHandle != null) { obj.sftp.close(obj.downloadHandle, function () { }); }
                                delete obj.downloadId;
                                delete obj.downloadBuffer;
                                delete obj.downloadHandle;
                                delete obj.downloadFullpath;
                                delete obj.downloadPosition;
                                delete obj.downloadPendingBlockCount;
                                break;
                            }
                        }
                        break;
                    }
                    case 'sshauth': {
                        if (obj.sshClient != null) return;

                        // Verify inputs
                        if ((typeof msg.username != 'string') || ((typeof msg.password != 'string') && (typeof msg.key != 'string'))) break;

                        if (msg.keep === true) { msg.keep = 1; } // If true, change to 1. For user/pass, 1 to store user/pass in db. For user/key/pass, 1 to store user/key in db, 2 to store everything in db.
                        obj.keep = msg.keep; // If set, keep store credentials on the server if the SSH tunnel connected succesfully.
                        obj.username = msg.username;
                        obj.password = msg.password;
                        obj.privateKey = msg.key;
                        obj.privateKeyPass = msg.keypass;

                        // Create a mesh relay authentication cookie
                        const cookieContent = { userid: user._id, domainid: user.domain, nodeid: obj.nodeid, tcpport: obj.tcpport };
                        if (obj.relaynodeid) {
                            cookieContent.nodeid = obj.relaynodeid;
                            cookieContent.tcpaddr = obj.tcpaddr;
                        } else {
                            if (obj.mtype == 3) { cookieContent.lc = 1; } // This is a local device
                        }
                        startRelayConnection(parent.parent.encodeCookie(cookieContent, parent.parent.loginCookieEncryptionKey));
                        break;
                    }
                    case 'sshkeyauth': {
                        if (obj.sshClient != null) return;

                        // Verify inputs
                        if (typeof msg.keypass != 'string') break;

                        delete obj.keep;
                        obj.privateKeyPass = msg.keypass;

                        // Create a mesh relay authentication cookie
                        const cookieContent = { userid: user._id, domainid: user.domain, nodeid: obj.nodeid, tcpport: obj.tcpport };
                        if (obj.relaynodeid) {
                            cookieContent.nodeid = obj.relaynodeid;
                            cookieContent.tcpaddr = obj.tcpaddr;
                        } else {
                            if (obj.mtype == 3) { cookieContent.lc = 1; } // This is a local device
                        }
                        startRelayConnection(parent.parent.encodeCookie(cookieContent, parent.parent.loginCookieEncryptionKey));
                        break;
                    }
                }
            }
        } catch (ex) { obj.close(); }
    });

    function uploadNextBlock() {
        if (obj.downloadBuffer == null) return;
        obj.sftp.read(obj.downloadHandle, obj.downloadBuffer, 4, obj.downloadBuffer.length - 4, obj.downloadPosition, function (err, len, buf) {
            obj.downloadPendingBlockCount--;
            if (obj.downloadBuffer == null) return;
            if (err != null) {
                try { obj.ws.send(Buffer.from(JSON.stringify({ action: 'download', sub: 'cancel', id: obj.downloadId }))) } catch (ex) { }
            } else {
                obj.downloadPosition += len;
                if (len < (obj.downloadBuffer.length - 4)) {
                    obj.downloadBuffer.writeInt32BE(0x01000001, 0)
                    if (len > 0) { try { obj.ws.send(obj.downloadBuffer.slice(0, len + 4)); } catch (ex) { console.log(ex); } }
                } else {
                    obj.downloadBuffer.writeInt32BE(0x01000000, 0);
                    try { obj.ws.send(obj.downloadBuffer.slice(0, len + 4)); } catch (ex) { console.log(ex); }
                    if (obj.downloadPendingBlockCount > 0) { uploadNextBlock(); }
                    return;
                }
            }
            if (obj.downloadHandle != null) { obj.sftp.close(obj.downloadHandle, function () { }); }
            delete obj.downloadId;
            delete obj.downloadBuffer;
            delete obj.downloadHandle;
            delete obj.downloadFullpath;
            delete obj.downloadPosition;
            delete obj.downloadPendingBlockCount;
        });
    }

    // If error, do nothing
    ws.on('error', function (err) { parent.parent.debug('relay', 'SSH: Browser websocket error: ' + err); obj.close(); });

    // If the web socket is closed
    ws.on('close', function (req) { parent.parent.debug('relay', 'SSH: Browser websocket closed'); obj.close(); });

    // Check that we have a user and nodeid
    if ((user == null) || (req.query.nodeid == null)) { obj.close(); return; } // Invalid nodeid
    parent.GetNodeWithRights(domain, user, req.query.nodeid, function (node, rights, visible) {
        if (obj.ws == null) return; // obj has been cleaned up, just exit.

        // Check permissions
        if ((rights & 8) == 0) { obj.close(); return; } // No MESHRIGHT_REMOTECONTROL rights
        if ((rights != 0xFFFFFFFF) && (rights & 0x00000200)) { obj.close(); return; } // MESHRIGHT_NOTERMINAL is set
        obj.mtype = node.mtype; // Store the device group type
        obj.nodeid = node._id; // Store the NodeID
        obj.meshid = node.meshid; // Store the MeshID

        // Check the SSH port
        obj.tcpport = 22;
        if (typeof node.sshport == 'number') { obj.tcpport = node.sshport; }

        // Check if we need to relay thru a different agent
        const mesh = parent.meshes[obj.meshid];
        if (mesh && mesh.relayid) { obj.relaynodeid = mesh.relayid; obj.tcpaddr = node.host; }

        // Check if we have rights to the relayid device, does nothing if a relay is not used
        checkRelayRights(parent, domain, user, obj.relaynodeid, function (allowed) {
            if (obj.ws == null) return; // obj has been cleaned up, just exit.
            if (allowed !== true) { parent.parent.debug('relay', 'SSH: Attempt to use un-authorized relay'); obj.close(); return; }

            // We are all set, start receiving data
            ws._socket.resume();

            // Check if we have SSH credentials for this device
            if ((domain.allowsavingdevicecredentials === false) || (node.ssh == null) || (typeof node.ssh != 'object') || (node.ssh[user._id] == null) || (typeof node.ssh[user._id].u != 'string') || ((typeof node.ssh[user._id].p != 'string') && (typeof node.ssh[user._id].k != 'string'))) {
                // Send a request for SSH authentication
                try { ws.send(JSON.stringify({ action: 'sshauth' })) } catch (ex) { }
            } else if ((typeof node.ssh[user._id].k == 'string') && (typeof node.ssh[user._id].kp != 'string')) {
                // Send a request for SSH authentication with option for only the private key password
                obj.username = node.ssh[user._id].u;
                obj.privateKey = node.ssh[user._id].k;
                try { ws.send(JSON.stringify({ action: 'sshauth', askkeypass: true })) } catch (ex) { }
            } else {
                // Use our existing credentials
                obj.username = node.ssh[user._id].u;
                if (typeof node.ssh[user._id].p == 'string') {
                    obj.password = node.ssh[user._id].p;
                } else if (typeof node.ssh[user._id].k == 'string') {
                    obj.privateKey = node.ssh[user._id].k;
                    obj.privateKeyPass = node.ssh[user._id].kp;
                }

                // Create a mesh relay authentication cookie
                const cookieContent = { userid: user._id, domainid: user.domain, nodeid: obj.nodeid, tcpport: obj.tcpport };
                if (obj.relaynodeid) {
                    cookieContent.nodeid = obj.relaynodeid;
                    cookieContent.tcpaddr = obj.tcpaddr;
                } else {
                    if (obj.mtype == 3) { cookieContent.lc = 1; } // This is a local device
                }
                startRelayConnection(parent.parent.encodeCookie(cookieContent, parent.parent.loginCookieEncryptionKey));
            }
        });
    });

    return obj;
};


// Check that the user has full rights on a relay device before allowing it.
function checkRelayRights(parent, domain, user, relayNodeId, func) {
    if (relayNodeId == null) { func(true); return; } // No relay, do nothing.
    parent.GetNodeWithRights(domain, user, relayNodeId, function (node, rights, visible) {
        func((node != null) && (rights == 0xFFFFFFFF));
    });
}