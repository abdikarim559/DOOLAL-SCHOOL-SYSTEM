const { execSync } = require('child_process');
const path = require('path');
const PROJECT_ROOT = 'c:\\Users\\Abdikhaliq\\OneDrive\\Desktop\\Abdikarim\\SCHOOL SYSTEM';
const SCRATCH = 'C:\\Users\\Abdikhaliq\\.gemini\\antigravity-ide\\brain\\8afaf138-70f4-44bb-ae99-e2c07b20a5b4\\scratch';
require(path.join(PROJECT_ROOT, 'node_modules', 'dotenv')).config({ path: path.join(PROJECT_ROOT, '.env') });
const jwt = require(path.join(PROJECT_ROOT, 'node_modules', 'jsonwebtoken'));

const adminToken = jwt.sign(
    { id: '69cd2227bdd0f68e231c85ed', role: 'admin' },
    process.env.JWT_SECRET,
    { expiresIn: '1h' }
);

const suiteFile = process.argv[2];
if (!suiteFile) {
    console.error('Usage: node run_suite_with_token.js <suite_file.js>');
    process.exit(1);
}

const fullPath = path.isAbsolute(suiteFile) ? suiteFile : path.join(SCRATCH, suiteFile);
try {
    const out = execSync(`node "${fullPath}"`, {
        cwd: PROJECT_ROOT,
        encoding: 'utf8',
        stdio: 'inherit',
        env: { ...process.env, ADMIN_TOKEN: adminToken }
    });
} catch (e) {
    process.exit(e.status || 1);
}
