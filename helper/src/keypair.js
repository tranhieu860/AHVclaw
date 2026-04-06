// /opt/ahvclaw/helper/src/keypair.js
// Device keypair: RSA 2048, encrypted at rest with machine-derived AES-256-GCM.
// Private key NEVER leaves this process. Stored encrypted, decrypted only in memory.
const forge = require("node-forge");
const fs = require("fs");
const path = require("path");
const os = require("os");
const crypto = require("crypto");

// Derive a machine-specific encryption key from hardware/OS identifiers.
// Not a substitute for OS keychain, but significantly better than raw PEM.
function deriveMachineKey() {
    const hostname = os.hostname();
    const platform = os.platform();
    const user = os.userInfo().username;
    const cpus = os.cpus().map(c => c.model).join(",");
    const identity = `ahvclaw:${hostname}:${platform}:${user}:${cpus}`;
    return crypto.createHash("sha256").update(identity).digest(); // 32 bytes for AES-256
}

function encryptPEM(pem) {
    const key = deriveMachineKey();
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
    let encrypted = cipher.update(pem, "utf8", "base64");
    encrypted += cipher.final("base64");
    const tag = cipher.getAuthTag();
    return JSON.stringify({
        v: 1,
        iv: iv.toString("base64"),
        tag: tag.toString("base64"),
        data: encrypted,
    });
}

function decryptPEM(encryptedJSON) {
    const { v, iv, tag, data } = JSON.parse(encryptedJSON);
    if (v !== 1) throw new Error("unsupported key encryption version");
    const key = deriveMachineKey();
    const decipher = crypto.createDecipheriv(
        "aes-256-gcm",
        key,
        Buffer.from(iv, "base64")
    );
    decipher.setAuthTag(Buffer.from(tag, "base64"));
    let decrypted = decipher.update(data, "base64", "utf8");
    decrypted += decipher.final("utf8");
    return decrypted;
}

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
        const privPath = path.join(keyDir, "device.key.enc");
        const privPathLegacy = path.join(keyDir, "device.key"); // raw PEM (pre-encryption)
        const pubPath = path.join(keyDir, "device.pub");
        const deviceId = Keypair.generateDeviceId();

        // Try loading encrypted key
        if (fs.existsSync(privPath) && fs.existsSync(pubPath)) {
            try {
                const encData = fs.readFileSync(privPath, "utf8");
                const privPEM = decryptPEM(encData);
                const pubPEM = fs.readFileSync(pubPath, "utf8");
                const privateKey = forge.pki.privateKeyFromPem(privPEM);
                console.log("[keypair] loaded encrypted device key");
                return new Keypair(privateKey, pubPEM, deviceId);
            } catch (err) {
                console.error("[keypair] failed to decrypt key (machine identity changed?):", err.message);
                // Fall through to regenerate
            }
        }

        // Migrate legacy raw PEM if exists
        if (fs.existsSync(privPathLegacy) && fs.existsSync(pubPath)) {
            try {
                const privPEM = fs.readFileSync(privPathLegacy, "utf8");
                const pubPEM = fs.readFileSync(pubPath, "utf8");
                const privateKey = forge.pki.privateKeyFromPem(privPEM);
                // Re-save encrypted
                fs.writeFileSync(privPath, encryptPEM(privPEM), { mode: 0o600 });
                fs.unlinkSync(privPathLegacy); // remove raw PEM
                console.log("[keypair] migrated legacy key to encrypted storage");
                return new Keypair(privateKey, pubPEM, deviceId);
            } catch (err) {
                console.error("[keypair] failed to migrate legacy key:", err.message);
            }
        }

        // Generate new keypair
        console.log("[keypair] generating new device keypair...");
        const keypair = forge.pki.rsa.generateKeyPair({ bits: 2048 });
        const privPEM = forge.pki.privateKeyToPem(keypair.privateKey);
        const pubPEM = forge.pki.publicKeyToPem(keypair.publicKey);

        fs.writeFileSync(privPath, encryptPEM(privPEM), { mode: 0o600 });
        fs.writeFileSync(pubPath, pubPEM, { mode: 0o644 });
        console.log("[keypair] device keypair generated (encrypted at rest)");

        return new Keypair(keypair.privateKey, pubPEM, deviceId);
    }
}

module.exports = Keypair;
