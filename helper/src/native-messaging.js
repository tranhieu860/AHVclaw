// /opt/ahvclaw/helper/src/native-messaging.js
// Chrome Native Messaging protocol: 4-byte length prefix + JSON payload.

class NativeMessaging {
    constructor() {
        this.handlers = new Map();
    }

    onMessage(type, handler) {
        this.handlers.set(type, handler);
    }

    start() {
        let buffer = Buffer.alloc(0);

        process.stdin.on("data", (chunk) => {
            buffer = Buffer.concat([buffer, chunk]);

            while (buffer.length >= 4) {
                const msgLength = buffer.readUInt32LE(0);
                if (buffer.length < 4 + msgLength) break;

                const msgJSON = buffer.slice(4, 4 + msgLength).toString("utf8");
                buffer = buffer.slice(4 + msgLength);

                try {
                    const msg = JSON.parse(msgJSON);
                    const handler = this.handlers.get(msg.type);
                    if (handler) {
                        handler(msg);
                    }
                } catch (err) {
                    console.error("[native-messaging] parse error:", err.message);
                }
            }
        });
    }

    send(msg) {
        const json = JSON.stringify(msg);
        const header = Buffer.alloc(4);
        header.writeUInt32LE(json.length, 0);
        process.stdout.write(header);
        process.stdout.write(json);
    }
}

module.exports = NativeMessaging;
