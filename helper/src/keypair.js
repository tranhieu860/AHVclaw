// /opt/ahvclaw/helper/src/keypair.js
// Device keypair generation, OS secure storage, hello signing.
const forge = require("node-forge");
const fs = require("fs");
const path = require("path");
const os = require("os");
const crypto = require("crypto");

class Keypair {
    constructor(privateKey, publicKeyPEM, deviceId) {
        this.privateKey = privateKey;
        this.publicKeyPEM = publicKeyPEM;
        this.deviceId = deviceId;
    }

    sign(payload) {
        const md = forge.md.sha256.create();
        md.update(payload, "utf8");
        const signature = this.privateKey.sign(md);
        return forge.util.encode64(signature);
    }

    static getKeyDir() {
        const home = os.homedir();
        const dir = path.join(home, ".ahvclaw-helper", "keys");
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
        return dir;
    }

    static generateDeviceId() {
        const hostname = os.hostname();
        const platform = os.platform();
        const user = os.userInfo().username;
        return crypto.createHash("sha256")
            .update(`${hostname}:${platform}:${user}`)
            .digest("hex")
            .substring(0, 32);
    }

    static async loadOrGenerate() {
        const keyDir = Keypair.getKeyDir();
        const privPath = path.join(keyDir, "device.key");
        const pubPath = path.join(keyDir, "device.pub");
        const deviceId = Keypair.generateDeviceId();

        if (fs.existsSync(privPath) && fs.existsSync(pubPath)) {
            const privPEM = fs.readFileSync(privPath, "utf8");
            const pubPEM = fs.readFileSync(pubPath, "utf8");
            const privateKey = forge.pki.privateKeyFromPem(privPEM);
            console.log("[keypair] loaded existing device key");
            return new Keypair(privateKey, pubPEM, deviceId);
        }

        console.log("[keypair] generating new device keypair...");
        const keypair = forge.pki.rsa.generateKeyPair({ bits: 2048 });
        const privPEM = forge.pki.privateKeyToPem(keypair.privateKey);
        const pubPEM = forge.pki.publicKeyToPem(keypair.publicKey);

        fs.writeFileSync(privPath, privPEM, { mode: 0o600 });
        fs.writeFileSync(pubPath, pubPEM, { mode: 0o644 });
        console.log("[keypair] device keypair generated and saved");

        return new Keypair(keypair.privateKey, pubPEM, deviceId);
    }
}

module.exports = Keypair;
