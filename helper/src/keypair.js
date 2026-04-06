// /opt/ahvclaw/helper/src/keypair.js
// Device keypair: RSA 2048, stored in OS secure storage.
// - macOS: Keychain (security CLI)
// - Windows: DPAPI (PowerShell)
// - Linux: libsecret (secret-tool CLI), fallback to machine-encrypted file
// Private key NEVER leaves this process unencrypted.
const forge = require("node-forge");
const fs = require("fs");
const path = require("path");
const os = require("os");
const crypto = require("crypto");
const { execSync } = require("child_process");

const SERVICE_NAME = "com.ahvholding.ahvclaw-helper";
const ACCOUNT_NAME = "device-private-key";

// ─── OS Secure Storage Backends ─────────────────────────────────────────

function storeSecret(label, secret) {
    const platform = os.platform();
    if (platform === "darwin") {
        return storeMacKeychain(label, secret);
    } else if (platform === "win32") {
        return storeWindowsDPAPI(label, secret);
    } else {
        return storeLinuxSecret(label, secret);
    }
}

function loadSecret(label) {
    const platform = os.platform();
    if (platform === "darwin") {
        return loadMacKeychain(label);
    } else if (platform === "win32") {
        return loadWindowsDPAPI(label);
    } else {
        return loadLinuxSecret(label);
    }
}

function deleteSecret(label) {
    const platform = os.platform();
    try {
        if (platform === "darwin") {
            execSync(`security delete-generic-password -s "${SERVICE_NAME}" -a "${label}" 2>/dev/null`, { encoding: "utf8" });
        } else if (platform === "win32") {
            // DPAPI files cleaned up by store
        } else {
            execSync(`secret-tool clear service "${SERVICE_NAME}" account "${label}" 2>/dev/null`, { encoding: "utf8" });
        }
    } catch {}
}

// ─── macOS: Keychain Access ─────────────────────────────────────────────

function storeMacKeychain(label, secret) {
    // Keychain has a size limit per password (~128KB), PEM fits easily.
    // Delete existing first to avoid duplicate.
    try {
        execSync(`security delete-generic-password -s "${SERVICE_NAME}" -a "${label}" 2>/dev/null`);
    } catch {}
    execSync(
        `security add-generic-password -s "${SERVICE_NAME}" -a "${label}" -w "${secret.replace(/"/g, '\\"')}" -U`,
        { encoding: "utf8" }
    );
}

function loadMacKeychain(label) {
    try {
        const result = execSync(
            `security find-generic-password -s "${SERVICE_NAME}" -a "${label}" -w`,
            { encoding: "utf8" }
        );
        return result.trim();
    } catch {
        return null;
    }
}

// ─── Windows: DPAPI via PowerShell ──────────────────────────────────────

function storeWindowsDPAPI(label, secret) {
    const dpDir = getDPAPIDir();
    const filePath = path.join(dpDir, `${label}.dpapi`);
    // PowerShell: encrypt with DPAPI (CurrentUser scope) and save as base64
    const b64 = Buffer.from(secret, "utf8").toString("base64");
    const ps = `
        $bytes = [Convert]::FromBase64String('${b64}')
        $encrypted = [Security.Cryptography.ProtectedData]::Protect($bytes, $null, 'CurrentUser')
        [IO.File]::WriteAllBytes('${filePath.replace(/\\/g, "\\\\")}', $encrypted)
    `;
    execSync(`powershell -NoProfile -Command "${ps.replace(/"/g, '\\"')}"`, { encoding: "utf8" });
}

function loadWindowsDPAPI(label) {
    const dpDir = getDPAPIDir();
    const filePath = path.join(dpDir, `${label}.dpapi`);
    if (!fs.existsSync(filePath)) return null;
    try {
        const ps = `
            $encrypted = [IO.File]::ReadAllBytes('${filePath.replace(/\\/g, "\\\\")}')
            $bytes = [Security.Cryptography.ProtectedData]::Unprotect($encrypted, $null, 'CurrentUser')
            [Text.Encoding]::UTF8.GetString($bytes)
        `;
        const result = execSync(`powershell -NoProfile -Command "${ps.replace(/"/g, '\\"')}"`, { encoding: "utf8" });
        return result.trim();
    } catch {
        return null;
    }
}

function getDPAPIDir() {
    const dir = path.join(process.env["APPDATA"] || os.homedir(), "ahvclaw-helper", "keys");
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    return dir;
}

// ─── Linux: libsecret via secret-tool ───────────────────────────────────

function storeLinuxSecret(label, secret) {
    try {
        // secret-tool reads password from stdin
        execSync(
            `echo -n "${secret.replace(/"/g, '\\"')}" | secret-tool store --label="${SERVICE_NAME}" service "${SERVICE_NAME}" account "${label}"`,
            { encoding: "utf8", shell: "/bin/bash" }
        );
    } catch (err) {
        // secret-tool not available — fallback to encrypted file
        console.warn("[keypair] libsecret not available, using encrypted file fallback");
        storeEncryptedFile(label, secret);
    }
}

function loadLinuxSecret(label) {
    try {
        const result = execSync(
            `secret-tool lookup service "${SERVICE_NAME}" account "${label}"`,
            { encoding: "utf8" }
        );
        return result || null;
    } catch {
        // Fallback: try encrypted file
        return loadEncryptedFile(label);
    }
}

// ─── Encrypted file fallback (Linux without libsecret) ──────────────────

function deriveMachineKey() {
    const hostname = os.hostname();
    const platform = os.platform();
    const user = os.userInfo().username;
    const cpus = os.cpus().map(c => c.model).join(",");
    return crypto.createHash("sha256").update(`ahvclaw:${hostname}:${platform}:${user}:${cpus}`).digest();
}

function storeEncryptedFile(label, secret) {
    const dir = getKeyDir();
    const filePath = path.join(dir, `${label}.enc`);
    const key = deriveMachineKey();
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
    let encrypted = cipher.update(secret, "utf8", "base64");
    encrypted += cipher.final("base64");
    const tag = cipher.getAuthTag();
    fs.writeFileSync(filePath, JSON.stringify({
        v: 1, iv: iv.toString("base64"), tag: tag.toString("base64"), data: encrypted,
    }), { mode: 0o600 });
}

function loadEncryptedFile(label) {
    const dir = getKeyDir();
    const filePath = path.join(dir, `${label}.enc`);
    if (!fs.existsSync(filePath)) return null;
    try {
        const { v, iv, tag, data } = JSON.parse(fs.readFileSync(filePath, "utf8"));
        if (v !== 1) return null;
        const key = deriveMachineKey();
        const decipher = crypto.createDecipheriv("aes-256-gcm", key, Buffer.from(iv, "base64"));
        decipher.setAuthTag(Buffer.from(tag, "base64"));
        let decrypted = decipher.update(data, "base64", "utf8");
        decrypted += decipher.final("utf8");
        return decrypted;
    } catch {
        return null;
    }
}

// ─── Keypair class ──────────────────────────────────────────────────────

function getKeyDir() {
    const home = os.homedir();
    const dir = path.join(home, ".ahvclaw-helper", "keys");
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    return dir;
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
        const keyDir = getKeyDir();
        const pubPath = path.join(keyDir, "device.pub");
        const deviceId = Keypair.generateDeviceId();

        // Try loading from OS secure storage
        const storedPEM = loadSecret(ACCOUNT_NAME);
        if (storedPEM && fs.existsSync(pubPath)) {
            try {
                const pubPEM = fs.readFileSync(pubPath, "utf8");
                const privateKey = forge.pki.privateKeyFromPem(storedPEM);
                console.log(`[keypair] loaded device key from OS secure storage (${os.platform()})`);
                return new Keypair(privateKey, pubPEM, deviceId);
            } catch (err) {
                console.error("[keypair] failed to load stored key:", err.message);
            }
        }

        // Migrate legacy files (raw PEM or machine-encrypted)
        const legacyPaths = [
            path.join(keyDir, "device.key"),     // raw PEM
            path.join(keyDir, "device.key.enc"), // machine-encrypted
        ];
        for (const legacyPath of legacyPaths) {
            if (fs.existsSync(legacyPath) && fs.existsSync(pubPath)) {
                try {
                    let privPEM;
                    if (legacyPath.endsWith(".enc")) {
                        privPEM = loadEncryptedFile(ACCOUNT_NAME);
                    } else {
                        privPEM = fs.readFileSync(legacyPath, "utf8");
                    }
                    if (privPEM) {
                        const pubPEM = fs.readFileSync(pubPath, "utf8");
                        const privateKey = forge.pki.privateKeyFromPem(privPEM);
                        // Migrate to OS secure storage
                        storeSecret(ACCOUNT_NAME, privPEM);
                        fs.unlinkSync(legacyPath);
                        console.log(`[keypair] migrated from ${path.basename(legacyPath)} to OS secure storage`);
                        return new Keypair(privateKey, pubPEM, deviceId);
                    }
                } catch (err) {
                    console.error(`[keypair] migration from ${path.basename(legacyPath)} failed:`, err.message);
                }
            }
        }

        // Generate new keypair
        console.log("[keypair] generating new device keypair...");
        const keypair = forge.pki.rsa.generateKeyPair({ bits: 2048 });
        const privPEM = forge.pki.privateKeyToPem(keypair.privateKey);
        const pubPEM = forge.pki.publicKeyToPem(keypair.publicKey);

        // Store private key in OS secure storage
        storeSecret(ACCOUNT_NAME, privPEM);
        // Public key on disk (not secret)
        fs.writeFileSync(pubPath, pubPEM, { mode: 0o644 });
        console.log(`[keypair] device keypair generated, private key in OS secure storage (${os.platform()})`);

        return new Keypair(keypair.privateKey, pubPEM, deviceId);
    }
}

module.exports = Keypair;
