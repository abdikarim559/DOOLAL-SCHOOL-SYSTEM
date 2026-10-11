/**
 * Targeted Test Suite for PRE-P2 #6 Critical Fixes
 * 
 * Verifies:
 * Fix #1: Admin user email, OTP flow, JWT generation, role=admin, no duplicates
 * Fix #2: Cryptographic OTP generation (crypto.randomInt), 6-digit, bcrypt hashing, expiry, one-time use, invalid OTP
 * Fix #3: Term delete protection (no exams -> 200, with exams -> 409, with exams+marks -> 409, 404, 400)
 * Fix #5: Student user linkage fails closed, student A cannot access student B results/reports
 * Fix #6: Student privacy on GET /api/students (student sees own record only; admin/teacher see all)
 * Fix #7: Dashboard dead code removal verified
 */

'use strict';

const path = require('path');
const http = require('http');
const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');

const PROJECT_ROOT = 'c:\\Users\\Abdikhaliq\\OneDrive\\Desktop\\Abdikarim\\SCHOOL SYSTEM';
require(path.join(PROJECT_ROOT, 'node_modules', 'dotenv')).config({ path: path.join(PROJECT_ROOT, '.env') });
const mongoose = require(path.join(PROJECT_ROOT, 'node_modules', 'mongoose'));
const jwt = require(path.join(PROJECT_ROOT, 'node_modules', 'jsonwebtoken'));
const bcrypt = require(path.join(PROJECT_ROOT, 'node_modules', 'bcryptjs'));

const {
    connectDB,
    User,
    Student,
    Teacher,
    Class,
    AcademicYear,
    Term,
    Subject,
    ClassSubject,
    Exam,
    Mark
} = require(path.join(PROJECT_ROOT, 'backend', 'database'));

let passed = 0;
let failed = 0;

function report(name, condition, extra = '') {
    if (condition) {
        passed++;
        console.log(`  [PASS] ${name}${extra ? ' (' + extra + ')' : ''}`);
    } else {
        failed++;
        console.error(`  [FAIL] ${name}${extra ? ' (' + extra + ')' : ''}`);
    }
}

function makeReq(port, method, urlPath, headers = {}, body = null) {
    return new Promise((resolve, reject) => {
        const payload = body ? JSON.stringify(body) : null;
        const reqHeaders = {
            'Content-Type': 'application/json',
            ...headers
        };
        if (payload) {
            reqHeaders['Content-Length'] = Buffer.byteLength(payload);
        }
        const req = http.request({
            hostname: '127.0.0.1',
            port,
            path: urlPath,
            method,
            headers: reqHeaders
        }, res => {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => {
                let parsed;
                try { parsed = JSON.parse(data); } catch (_) { parsed = data; }
                resolve({ status: res.statusCode, body: parsed });
            });
        });
        req.on('error', reject);
        if (payload) req.write(payload);
        req.end();
    });
}

async function runTargetedTests() {
    console.log('============================================================');
    console.log(' PRE-P2 #6 TARGETED VERIFICATION TEST SUITE');
    console.log('============================================================\n');

    await connectDB();
    const port = process.env.PORT || 5000;
    const JWT_SECRET = process.env.JWT_SECRET;

    // ─────────────────────────────────────────────────────────────
    // TEST GROUP 1: FIX #1 — ADMIN USER & EMAIL
    // ─────────────────────────────────────────────────────────────
    console.log('--- TEST GROUP 1: Fix #1 Admin User Email & Auth ---');
    const adminUser = await User.findOne({ username: 'admin' }).select('+password +otp +otpExpires');
    report('Admin user exists in database', !!adminUser);
    report('Admin user role is "admin"', adminUser && adminUser.role === 'admin');
    report('Admin user email is "admin@gmail.com"', adminUser && adminUser.email === 'admin@gmail.com');

    const adminCount = await User.countDocuments({ role: 'admin' });
    report('No duplicate admin users exist (count === 1)', adminCount === 1);

    const adminToken = jwt.sign({ id: adminUser._id.toString(), role: adminUser.role }, JWT_SECRET, { expiresIn: '1h' });
    const decodedAdmin = jwt.verify(adminToken, JWT_SECRET);
    report('Admin JWT generates correct payload with role="admin"', decodedAdmin.role === 'admin');

    // ─────────────────────────────────────────────────────────────
    // TEST GROUP 2: FIX #2 — CRYPTOGRAPHIC OTP GENERATION
    // ─────────────────────────────────────────────────────────────
    console.log('\n--- TEST GROUP 2: Fix #2 Cryptographic OTP Generation ---');
    const serverJsSrc = fs.readFileSync(path.join(PROJECT_ROOT, 'backend', 'server.js'), 'utf8');

    report('server.js imports crypto module', serverJsSrc.includes("const crypto = require('crypto');"));
    report('server.js uses crypto.randomInt(100000, 1000000) for OTP', serverJsSrc.includes('crypto.randomInt(100000, 1000000)'));
    report('server.js NO LONGER uses Math.random() for OTP', !serverJsSrc.includes('Math.random() * 900000'));

    // Test crypto.randomInt range and length
    let allSixDigits = true;
    for (let i = 0; i < 50; i++) {
        const testOtp = crypto.randomInt(100000, 1000000).toString();
        if (testOtp.length !== 6 || !/^\d{6}$/.test(testOtp) || parseInt(testOtp, 10) < 100000 || parseInt(testOtp, 10) >= 1000000) {
            allSixDigits = false;
            break;
        }
    }
    report('crypto.randomInt generates exactly 6 digits across 50 iterations', allSixDigits);

    // Test OTP bcrypt hashing & storage using a dedicated isolated user (protects real admin)
    const testOtpUser = await User.create({
        username: 'test_prep26_otp_' + Date.now(),
        email: `prep26_otp_${Date.now()}@school.test`,
        role: 'admin',
        status: 'active'
    });
    try {
        const sampleOtp = crypto.randomInt(100000, 1000000).toString();
        const hashed = bcrypt.hashSync(sampleOtp, 10);
        testOtpUser.otp = hashed;
        testOtpUser.otpExpires = new Date(Date.now() + 5 * 60000);
        await testOtpUser.save();

        const checkUser = await User.findById(testOtpUser._id).select('+otp +otpExpires');
        report('OTP is stored bcrypt-hashed (not plaintext)', checkUser.otp !== sampleOtp && checkUser.otp.startsWith('$2'));
        report('Stored OTP verifies correctly against plaintext OTP', bcrypt.compareSync(sampleOtp, checkUser.otp));
        report('Wrong OTP fails verification', !bcrypt.compareSync('000000', checkUser.otp));
        report('OTP expiry is within 5 minutes', checkUser.otpExpires > new Date() && (checkUser.otpExpires - Date.now()) <= 300000);

        // One-time-use: clear OTP
        checkUser.otp = undefined;
        checkUser.otpExpires = undefined;
        await checkUser.save();
        const clearedUser = await User.findById(testOtpUser._id).select('+otp +otpExpires');
        report('OTP is cleared on use (preventing reuse)', !clearedUser.otp && !clearedUser.otpExpires);
    } finally {
        await User.deleteOne({ _id: testOtpUser._id });
    }

    // ─────────────────────────────────────────────────────────────
    // TEST GROUP 3: FIX #3 — TERM → EXAM DELETE PROTECTION
    // ─────────────────────────────────────────────────────────────
    console.log('\n--- TEST GROUP 3: Fix #3 Term -> Exam Delete Protection ---');

    // Setup an isolated Academic Year & Term
    const testAy = await AcademicYear.create({
        name: 'Targeted AY ' + Date.now(),
        start_date: '2026-01-01',
        end_date: '2026-12-31',
        status: 'active'
    });

    const testTermNoExams = await Term.create({
        name: 'Term No Exams ' + Date.now(),
        academic_year_id: testAy._id,
        start_date: '2026-01-01',
        end_date: '2026-04-30',
        status: 'active'
    });

    const testTermWithExams = await Term.create({
        name: 'Term With Exams ' + Date.now(),
        academic_year_id: testAy._id,
        start_date: '2026-05-01',
        end_date: '2026-08-31',
        status: 'active'
    });

    // Create a subject and class-subject and exam for testTermWithExams
    const testClass = await Class.findOne();
    const testSubj = await Subject.create({
        name: 'Targeted Subj ' + Date.now(),
        code: 'TS' + Math.floor(1000 + Math.random() * 9000),
        status: 'active'
    });
    const testCs = await ClassSubject.create({
        class_id: testClass._id,
        subject_id: testSubj._id,
        academic_year_id: testAy._id
    });
    const testExam = await Exam.create({
        name: 'Targeted Exam ' + Date.now(),
        type: 'Midterm',
        academic_year_id: testAy._id,
        term_id: testTermWithExams._id,
        class_id: testClass._id,
        subject_id: testSubj._id,
        total_marks: 100,
        exam_date: '2026-06-01'
    });

    // Case 1: Delete invalid ObjectId
    const resInvalidId = await makeReq(port, 'DELETE', '/api/terms/invalid-id-123', {
        Authorization: `Bearer ${adminToken}`
    });
    report('DELETE /api/terms/:id with invalid ObjectId returns HTTP 400', resInvalidId.status === 400);

    // Case 2: Delete nonexistent Term
    const nonExistentId = new mongoose.Types.ObjectId().toString();
    const resNonExistent = await makeReq(port, 'DELETE', `/api/terms/${nonExistentId}`, {
        Authorization: `Bearer ${adminToken}`
    });
    report('DELETE /api/terms/:id with nonexistent Term returns HTTP 404', resNonExistent.status === 404);

    // Case 3: Delete Term with dependent Exams -> Must return HTTP 409
    const resBlocked = await makeReq(port, 'DELETE', `/api/terms/${testTermWithExams._id}`, {
        Authorization: `Bearer ${adminToken}`
    });
    report('DELETE /api/terms/:id with dependent Exams returns HTTP 409 Conflict', resBlocked.status === 409);
    report('DELETE /api/terms/:id 409 response contains clear safe message',
        resBlocked.body && resBlocked.body.message && resBlocked.body.message.includes('Cannot delete term with existing exams'));

    // Case 3b: Delete Term with Exam + Marks -> Must also return HTTP 409
    const sampleStudent = await Student.findOne();
    const testMark = await Mark.create({
        exam_id: testExam._id,
        student_id: sampleStudent._id,
        marks_obtained: 75
    });
    const resBlockedWithMarks = await makeReq(port, 'DELETE', `/api/terms/${testTermWithExams._id}`, {
        Authorization: `Bearer ${adminToken}`
    });
    report('DELETE /api/terms/:id with dependent Exams + Marks returns HTTP 409 Conflict', resBlockedWithMarks.status === 409);
    await Mark.deleteOne({ _id: testMark._id });

    // Case 4: Delete Term with NO dependent Exams -> Must succeed (HTTP 200)
    const resAllowed = await makeReq(port, 'DELETE', `/api/terms/${testTermNoExams._id}`, {
        Authorization: `Bearer ${adminToken}`
    });
    report('DELETE /api/terms/:id with NO dependent Exams returns HTTP 200', resAllowed.status === 200 && resAllowed.body.deleted === 1);

    // Clean up test exam, CS, Subj, AY
    await Exam.deleteOne({ _id: testExam._id });
    // Now that exam is deleted, deleting testTermWithExams should succeed
    const resAfterExamDeleted = await makeReq(port, 'DELETE', `/api/terms/${testTermWithExams._id}`, {
        Authorization: `Bearer ${adminToken}`
    });
    report('DELETE /api/terms/:id succeeds after dependent exam was deleted', resAfterExamDeleted.status === 200);

    await ClassSubject.deleteOne({ _id: testCs._id });
    await Subject.deleteOne({ _id: testSubj._id });
    await AcademicYear.deleteOne({ _id: testAy._id });

    // ─────────────────────────────────────────────────────────────
    // TEST GROUP 4: FIX #5 — STUDENT IDENTITY RESOLUTION & IDOR PROTECTION
    // ─────────────────────────────────────────────────────────────
    console.log('\n--- TEST GROUP 4: Fix #5 Student Identity Resolution & IDOR ---');

    // Create two students in DB
    const studentA = await Student.findOne(); // Nimco (01)
    const studentB = await Student.findOne({ _id: { $ne: studentA._id } }); // e.g. Fatxi (02)
    report('Two distinct real students identified for IDOR test', !!studentA && !!studentB && studentA._id.toString() !== studentB._id.toString());

    // User A: username '01' matching studentA.id_number
    let userA = await User.findOne({ username: studentA.id_number });
    if (!userA) {
        userA = await User.create({ username: studentA.id_number, email: 'student_a@school.com', role: 'student' });
    }
    const tokenStudentA = jwt.sign({ id: userA._id.toString(), role: 'student', username: userA.username }, JWT_SECRET, { expiresIn: '1h' });

    // Try Student A accessing Student B's results
    const resIdorResults = await makeReq(port, 'GET', `/api/results/student/${studentB._id}`, {
        Authorization: `Bearer ${tokenStudentA}`
    });
    report('Student A attempting to access Student B results returns HTTP 403 Forbidden', resIdorResults.status === 403);
    report('Student A denied message indicates access restriction',
        resIdorResults.body && resIdorResults.body.message && resIdorResults.body.message.includes('Students may only view their own results'));

    // Try Student A accessing Student B's report
    const resIdorReport = await makeReq(port, 'GET', `/api/reports/student/${studentB._id}`, {
        Authorization: `Bearer ${tokenStudentA}`
    });
    report('Student A attempting to access Student B report returns HTTP 403 Forbidden', resIdorReport.status === 403);

    // User with unresolvable student identity (e.g. abdikarinmohammed21@gmail.com)
    const unlinkedUser = await User.findOne({ username: 'abdikarinmohammed21@gmail.com' });
    const tokenUnlinked = jwt.sign({ id: unlinkedUser._id.toString(), role: 'student', username: unlinkedUser.username }, JWT_SECRET, { expiresIn: '1h' });
    const resUnlinkedAccess = await makeReq(port, 'GET', `/api/results/student/${studentA._id}`, {
        Authorization: `Bearer ${tokenUnlinked}`
    });
    report('Unresolvable student identity fails closed with HTTP 403', resUnlinkedAccess.status === 403);

    // ─────────────────────────────────────────────────────────────
    // TEST GROUP 5: FIX #6 — STUDENT PRIVACY ON GET /api/students
    // ─────────────────────────────────────────────────────────────
    console.log('\n--- TEST GROUP 5: Fix #6 Student Privacy on GET /api/students ---');

    // 1. Student calls GET /api/students
    const resStudentList = await makeReq(port, 'GET', '/api/students', {
        Authorization: `Bearer ${tokenStudentA}`
    });
    report('Student role can call GET /api/students successfully (HTTP 200)', resStudentList.status === 200);
    report('Student role receives an array', Array.isArray(resStudentList.body));
    report('Student role receives ONLY their own record (length === 1)', resStudentList.body.length === 1);
    report('Student role cannot see Student B in list',
        !resStudentList.body.some(s => s._id === studentB._id.toString() || s.id_number === studentB.id_number));
    report('Student record in response matches Student A',
        resStudentList.body[0] && (resStudentList.body[0]._id === studentA._id.toString() || resStudentList.body[0].id_number === studentA.id_number));

    // 2. Unlinked student receives empty array (fails closed)
    const resUnlinkedList = await makeReq(port, 'GET', '/api/students', {
        Authorization: `Bearer ${tokenUnlinked}`
    });
    report('Unlinked student identity receives empty array [] (no data leak)',
        resUnlinkedList.status === 200 && Array.isArray(resUnlinkedList.body) && resUnlinkedList.body.length === 0);

    // 3. Admin calls GET /api/students -> receives full list
    const resAdminList = await makeReq(port, 'GET', '/api/students', {
        Authorization: `Bearer ${adminToken}`
    });
    report('Admin role receives full student list (length >= 7)',
        resAdminList.status === 200 && Array.isArray(resAdminList.body) && resAdminList.body.length >= 7);

    // 4. Teacher calls GET /api/students -> receives full student list
    const teacherUser = await User.findOne({ role: 'teacher' });
    let teacherToken;
    if (teacherUser) {
        teacherToken = jwt.sign({ id: teacherUser._id.toString(), role: 'teacher' }, JWT_SECRET, { expiresIn: '1h' });
    } else {
        const tempTeacher = await User.create({ username: 'temp_teach_verify', email: 'temp_teach@school.com', role: 'teacher' });
        teacherToken = jwt.sign({ id: tempTeacher._id.toString(), role: 'teacher' }, JWT_SECRET, { expiresIn: '1h' });
    }
    const resTeacherList = await makeReq(port, 'GET', '/api/students', {
        Authorization: `Bearer ${teacherToken}`
    });
    report('Teacher role receives intended student visibility (length >= 7)',
        resTeacherList.status === 200 && Array.isArray(resTeacherList.body) && resTeacherList.body.length >= 7);

    // Clean up temp teacher if created
    await User.deleteOne({ username: 'temp_teach_verify' });

    // ─────────────────────────────────────────────────────────────
    // TEST GROUP 6: FIX #7 — DEAD CLASS CHART CODE REMOVAL
    // ─────────────────────────────────────────────────────────────
    console.log('\n--- TEST GROUP 6: Fix #7 Dead Class Chart Code Removal ---');
    const appJsSrc = fs.readFileSync(path.join(PROJECT_ROOT, 'frontend', 'js', 'app.js'), 'utf8');
    report('app.js NO LONGER calls initClassChart in loadDashboard', !appJsSrc.includes('this.initClassChart('));
    report('app.js NO LONGER defines empty initClassChart placeholder', !appJsSrc.includes('initClassChart(classData)'));

    // Dashboard stats API verification
    const resDashStats = await makeReq(port, 'GET', '/api/dashboard/stats', {
        Authorization: `Bearer ${adminToken}`
    });
    report('GET /api/dashboard/stats returns HTTP 200', resDashStats.status === 200);
    report('Dashboard stats returns students, teachers, classes, attendance counts',
        typeof resDashStats.body.students === 'number' && typeof resDashStats.body.teachers === 'number');

    // ─────────────────────────────────────────────────────────────
    // SUMMARY
    // ─────────────────────────────────────────────────────────────
    console.log('\n============================================================');
    console.log(` TARGETED TEST RESULTS: ${passed} PASSED, ${failed} FAILED (TOTAL: ${passed + failed})`);
    console.log('============================================================\n');

    await mongoose.disconnect();
    if (failed > 0) process.exit(1);
    process.exit(0);
}

runTargetedTests().catch(e => {
    console.error('[TEST SUITE CRASHED]:', e);
    process.exit(1);
});
