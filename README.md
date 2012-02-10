# dns-srv

A module to query SRV records from DNS servers

Usage: To query the *_xmpp-client._tcp* SRV record of *gmail.com*

    var srv = require('dns-srv');
    var net = require('net');
    
    var sock = new net.Stream();
    srv.connect(sock, ['_xmpp-client._tcp'], "gmail.com", 5222);
    
    sock.on('error', function() { console.error('meh...'); })
        .on('connect', function() { console.log('yeah baby!!'); });
