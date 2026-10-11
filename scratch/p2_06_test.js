/**
 * P2 #6 — User Management Automated Test Suite
 * Covers:
 * - Admin-only RBAC (401 unauthenticated, 403 student/teacher, 200 admin)
 * - Secret fields exclusion (password, otp, otpExpires never in API responses)
 * - Input validation & strict field allowlists (invalid ID, role, status, email, length)
 * - Duplicate username and email conflict (409)
 * - Role-specific student/teacher linkage & double-link protection (400, 409)
 * - Dedicated password reset endpoint & bcrypt verification
 * - Inactive account enforcement on send-otp & verify-otp (403)
 * - Last active admin demotion & deactivation protection (400)
 * - Permanent deletion prevention (400)
 * - Search regex escaping & filtering (role, status, search)
 * - Student privacy and IDOR restriction with explicit linkage
 * - OTP authentication flow
 */

'use strict';

require('dotenv').config();
const mongoose = require('mongoose');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');

const BASE_URL = 'http://localhost:5000';
const JWT_SECRET = process.env.JWT_SECRET || 'supersecret_school_mvp_key_123';

let passed = 0;
let failed = 0;

function assert(condition, testName, details = '') {
    if (condition) {
        console.log(`  [PASS] ${testName}`);
        passed++;
    } else {
        console.error(`  [FAIL] ${testName} ${details ? '- ' + details : ''}`);
        failed++;
    }
}

async function request(path, options = {}) {
    const url = `${BASE_URL}${path}`;
    const headers = options.headers || {};
    if (options.token) {
        headers['Authorization'] = `Bearer ${options.token}`;
    }
    if (options.body && typeof options.body === 'object' && !(options.body instanceof String)) {
        headers['Content-Type'] = 'application/json';
        options.body = JSON.stringify(options.body);
    }
    const res = await fetch(url, { ...options, headers });
    let data = null;
    const text = await res.text();
    try {
        data = JSON.parse(text);
    } catch (e) {
        data = text;
    }
    return { status: res.status, data };
}

async function runTests() {
    console.log('====================================================');
    console.log('STARTING P2 #6 USER MANAGEMENT TEST SUITE');
    console.log('====================================================');

    await mongoose.connect(process.env.MONGO_URI || 'mongodb://127.0.0.1:27017/school_management');
    const { User, Student, Teacher } = require('../backend/database');

    // Setup tokens
    const adminUser = await User.findOne({ username: 'admin' });
    if (!adminUser) {
        console.error('Fatal: admin user not found in database');
        process.exit(1);
    }
    const adminToken = jwt.sign({ id: adminUser._id.toString(), role: 'admin' }, JWT_SECRET, { expiresIn: '1h' });

    // Ensure we have a test teacher and student in DB
    let testStudent = await Student.findOne({ id_number: 'P2_6_STU_001' });
    if (!testStudent) {
        testStudent = await Student.create({
            full_name: 'P2_6 Test Student',
            id_number: 'P2_6_STU_001',
            class_name: 'GRADE 10',
            gender: 'Male',
            contact: '111-222-3333'
        });
    }

    let testTeacher = await Teacher.findOne({ name: 'P2_6 Test Teacher' });
    if (!testTeacher) {
        testTeacher = await Teacher.create({
            name: 'P2_6 Test Teacher',
            subject: 'Mathematics',
            phone: '444-555-6666'
        });
    }

    // Clean up any test users created by previous test runs
    await User.deleteMany({ username: { $regex: /^test_p2_6_/ } });

    try {
        // Create temporary teacher user & student user for RBAC checks
    const teacherUser = await User.create({
        username: 'test_p2_6_teacher_rbac',
        email: 'test_p2_6_teacher@school.test',
        role: 'teacher',
        status: 'active'
    });
    const teacherToken = jwt.sign({ id: teacherUser._id.toString(), role: 'teacher' }, JWT_SECRET, { expiresIn: '1h' });

    const studentUser = await User.create({
        username: 'test_p2_6_student_rbac',
        email: 'test_p2_6_student@school.test',
        role: 'student',
        status: 'active',
        student_id: testStudent._id
    });
    const studentToken = jwt.sign({ id: studentUser._id.toString(), role: 'student' }, JWT_SECRET, { expiresIn: '1h' });

    console.log('\n--- 1. RBAC & Authorization ---');
    {
        const noAuth = await request('/api/users');
        assert(noAuth.status === 401, 'GET /api/users rejects unauthenticated request (401)');

        const teacherReq = await request('/api/users', { token: teacherToken });
        assert(teacherReq.status === 403, 'GET /api/users rejects teacher role (403)');

        const studentReq = await request('/api/users', { token: studentToken });
        assert(studentReq.status === 403, 'GET /api/users rejects student role (403)');

        const adminReq = await request('/api/users', { token: adminToken });
        assert(adminReq.status === 200 && Array.isArray(adminReq.data), 'GET /api/users allows admin role (200)');
    }

    console.log('\n--- 2. Secret Fields Exclusion ---');
    {
        const listRes = await request('/api/users', { token: adminToken });
        const hasSecretsInList = listRes.data.some(u => u.password || u.otp || u.otpExpires);
        assert(!hasSecretsInList, 'GET /api/users excludes password, otp, and otpExpires');

        const singleRes = await request(`/api/users/${adminUser._id}`, { token: adminToken });
        assert(singleRes.status === 200, 'GET /api/users/:id succeeds for existing user');
        assert(!singleRes.data.password && !singleRes.data.otp && !singleRes.data.otpExpires, 'GET /api/users/:id excludes password, otp, otpExpires');
    }

    console.log('\n--- 3. User Creation & Input Validation ---');
    {
        // Invalid ID
        const invId = await request('/api/users/not-an-id', { token: adminToken });
        assert(invId.status === 400, 'GET /api/users/:invalidId returns 400');

        // Missing required fields
        const missingFields = await request('/api/users', {
            method: 'POST',
            token: adminToken,
            body: { username: '' }
        });
        assert(missingFields.status === 400, 'POST /api/users rejects empty username (400)');

        // Invalid email
        const badEmail = await request('/api/users', {
            method: 'POST',
            token: adminToken,
            body: { username: 'test_p2_6_bademail', email: 'not-an-email', role: 'teacher' }
        });
        assert(badEmail.status === 400, 'POST /api/users rejects invalid email format (400)');

        // Invalid role
        const badRole = await request('/api/users', {
            method: 'POST',
            token: adminToken,
            body: { username: 'test_p2_6_badrole', email: 'badrole@school.test', role: 'superadmin' }
        });
        assert(badRole.status === 400, 'POST /api/users rejects invalid role enum (400)');

        // Invalid password length (<6)
        const shortPwd = await request('/api/users', {
            method: 'POST',
            token: adminToken,
            body: { username: 'test_p2_6_shortpwd', email: 'shortpwd@school.test', role: 'teacher', password: '123' }
        });
        assert(shortPwd.status === 400, 'POST /api/users rejects password shorter than 6 chars (400)');

        // Successful creation with password and custom status
        const validUser = await request('/api/users', {
            method: 'POST',
            token: adminToken,
            body: {
                username: 'test_p2_6_valid_create',
                email: 'valid_create@school.test',
                role: 'teacher',
                password: 'ValidPassword123!',
                status: 'active'
            }
        });
        assert(validUser.status === 201, 'POST /api/users creates valid user (201)');
        assert(validUser.data.username === 'test_p2_6_valid_create', 'Created user has correct username');
        assert(validUser.data.email === 'valid_create@school.test', 'Created user has normalized email');
        assert(validUser.data.role === 'teacher', 'Created user has correct role');
        assert(validUser.data.status === 'active', 'Created user has active status');
        assert(!validUser.data.password && !validUser.data.otp, 'Created user response excludes password/otp');

        // Verify password in DB is bcrypt hashed
        const createdDoc = await User.findById(validUser.data.id).select('+password');
        assert(bcrypt.compareSync('ValidPassword123!', createdDoc.password), 'Password was securely hashed with bcrypt in DB');
    }

    console.log('\n--- 4. Uniqueness & Duplicate Protection ---');
    {
        // Duplicate username
        const dupUser = await request('/api/users', {
            method: 'POST',
            token: adminToken,
            body: {
                username: 'test_p2_6_valid_create',
                email: 'different_email@school.test',
                role: 'teacher'
            }
        });
        assert(dupUser.status === 409, 'POST /api/users rejects duplicate username (409)');

        // Duplicate email
        const dupEmail = await request('/api/users', {
            method: 'POST',
            token: adminToken,
            body: {
                username: 'test_p2_6_different_user',
                email: 'valid_create@school.test',
                role: 'teacher'
            }
        });
        assert(dupEmail.status === 409, 'POST /api/users rejects duplicate email (409)');
    }

    console.log('\n--- 5. Student / Teacher Explicit Linkages ---');
    {
        // Invalid student_id
        const badStuLink = await request('/api/users', {
            method: 'POST',
            token: adminToken,
            body: {
                username: 'test_p2_6_bad_stu_link',
                email: 'bad_stu_link@school.test',
                role: 'student',
                student_id: new mongoose.Types.ObjectId().toString()
            }
        });
        assert(badStuLink.status === 400, 'POST /api/users rejects nonexistent student_id (400)');

        let testStudentForLink = await Student.create({
            full_name: 'P2_6 Student For Link',
            id_number: 'P2_6_STU_LINK_001',
            class_name: 'GRADE 10',
            gender: 'Male',
            contact: '555-666-7777'
        });

        // Valid student linkage
        const goodStuLink = await request('/api/users', {
            method: 'POST',
            token: adminToken,
            body: {
                username: 'test_p2_6_good_stu_link',
                email: 'good_stu_link@school.test',
                role: 'student',
                student_id: testStudentForLink._id.toString()
            }
        });
        assert(goodStuLink.status === 201, 'POST /api/users succeeds with valid student_id (201)');
        assert(goodStuLink.data.student_id && goodStuLink.data.student_id._id === testStudentForLink._id.toString(), 'Response populates student_id object');

        // Prevent double linking the same student to a 2nd user account
        const doubleStuLink = await request('/api/users', {
            method: 'POST',
            token: adminToken,
            body: {
                username: 'test_p2_6_double_stu_link',
                email: 'double_stu_link@school.test',
                role: 'student',
                student_id: testStudentForLink._id.toString()
            }
        });
        assert(doubleStuLink.status === 409, 'POST /api/users rejects linking student already linked to another account (409)');

        let testTeacherForLink = await Teacher.create({
            name: 'P2_6 Teacher For Link',
            subject: 'Physics',
            phone: '777-888-9999'
        });

        // Valid teacher linkage
        const goodTeachLink = await request('/api/users', {
            method: 'POST',
            token: adminToken,
            body: {
                username: 'test_p2_6_good_teach_link',
                email: 'good_teach_link@school.test',
                role: 'teacher',
                teacher_id: testTeacherForLink._id.toString()
            }
        });
        assert(goodTeachLink.status === 201, 'POST /api/users succeeds with valid teacher_id (201)');
        assert(goodTeachLink.data.teacher_id && goodTeachLink.data.teacher_id._id === testTeacherForLink._id.toString(), 'Response populates teacher_id object');

        // Prevent double linking the same teacher
        const doubleTeachLink = await request('/api/users', {
            method: 'POST',
            token: adminToken,
            body: {
                username: 'test_p2_6_double_teach_link',
                email: 'double_teach_link@school.test',
                role: 'teacher',
                teacher_id: testTeacherForLink._id.toString()
            }
        });
        assert(doubleTeachLink.status === 409, 'POST /api/users rejects linking teacher already linked to another account (409)');
    }

    console.log('\n--- 6. Password Reset Endpoint ---');
    {
        const userToReset = await User.create({
            username: 'test_p2_6_pwd_target',
            email: 'pwd_target@school.test',
            role: 'teacher',
            password: bcrypt.hashSync('OldPassword123!', 10),
            status: 'active'
        });

        // Non-admin cannot reset password
        const unauthReset = await request(`/api/users/${userToReset._id}/reset-password`, {
            method: 'POST',
            token: teacherToken,
            body: { password: 'NewPassword999!' }
        });
        assert(unauthReset.status === 403, 'POST /api/users/:id/reset-password rejects non-admin (403)');

        // Short password rejected
        const shortReset = await request(`/api/users/${userToReset._id}/reset-password`, {
            method: 'POST',
            token: adminToken,
            body: { password: '123' }
        });
        assert(shortReset.status === 400, 'POST /api/users/:id/reset-password rejects short password (400)');

        // Successful reset
        const goodReset = await request(`/api/users/${userToReset._id}/reset-password`, {
            method: 'POST',
            token: adminToken,
            body: { password: 'BrandNewPassword123!' }
        });
        assert(goodReset.status === 200, 'POST /api/users/:id/reset-password succeeds (200)');

        // Verify password changed in DB
        const updatedDoc = await User.findById(userToReset._id).select('+password');
        assert(bcrypt.compareSync('BrandNewPassword123!', updatedDoc.password), 'Password hash in DB matches new password');
        assert(!bcrypt.compareSync('OldPassword123!', updatedDoc.password), 'Old password hash no longer matches');
    }

    console.log('\n--- 7. Account Status & Inactive Login Prevention ---');
    {
        const accountToDeactivate = await User.create({
            username: 'test_p2_6_deact_target',
            email: 'deact_target@school.test',
            role: 'teacher',
            status: 'active'
        });

        // Toggle status to inactive
        const patchStatus = await request(`/api/users/${accountToDeactivate._id}/status`, {
            method: 'PATCH',
            token: adminToken,
            body: { status: 'inactive' }
        });
        assert(patchStatus.status === 200, 'PATCH /api/users/:id/status toggles status to inactive (200)');
        assert(patchStatus.data.status === 'inactive', 'User status is inactive in response');

        // Inactive account cannot request OTP
        const inactiveOtpSend = await request('/api/send-otp', {
            method: 'POST',
            body: { email: 'deact_target@school.test' }
        });
        assert(inactiveOtpSend.status === 403, 'Inactive account cannot request OTP via POST /api/send-otp (403)');

        // If inactive account somehow attempts verify-otp
        const inactiveOtpVerify = await request('/api/verify-otp', {
            method: 'POST',
            body: { email: 'deact_target@school.test', otp: '123456' }
        });
        assert(inactiveOtpVerify.status === 403, 'Inactive account cannot verify OTP via POST /api/verify-otp (403)');

        // Reactivate account
        const reactivateStatus = await request(`/api/users/${accountToDeactivate._id}/status`, {
            method: 'PATCH',
            token: adminToken,
            body: { status: 'active' }
        });
        assert(reactivateStatus.status === 200, 'PATCH /api/users/:id/status reactivates account (200)');
        assert(reactivateStatus.data.status === 'active', 'User status is active in response');

        // Now active account CAN request OTP
        const activeOtpSend = await request('/api/send-otp', {
            method: 'POST',
            body: { email: 'deact_target@school.test' }
        });
        assert(activeOtpSend.status === 200, 'Reactivated account successfully requests OTP (200)');
    }

    console.log('\n--- 8. Last Active Admin Protection ---');
    {
        // Try deactivating the main admin
        const deactMainAdmin = await request(`/api/users/${adminUser._id}/status`, {
            method: 'PATCH',
            token: adminToken,
            body: { status: 'inactive' }
        });
        assert(deactMainAdmin.status === 400, 'Deactivating last active admin is blocked (400)');

        // Try demoting the main admin via PUT
        const demoteMainAdmin = await request(`/api/users/${adminUser._id}`, {
            method: 'PUT',
            token: adminToken,
            body: { role: 'teacher' }
        });
        assert(demoteMainAdmin.status === 400, 'Demoting last active admin is blocked (400)');

        // Create a 2nd admin
        const secondAdmin = await User.create({
            username: 'test_p2_6_second_admin',
            email: 'second_admin@school.test',
            role: 'admin',
            status: 'active'
        });

        // Now deactivating the 2nd admin should succeed because 1 active admin remains
        const deactSecondAdmin = await request(`/api/users/${secondAdmin._id}/status`, {
            method: 'PATCH',
            token: adminToken,
            body: { status: 'inactive' }
        });
        assert(deactSecondAdmin.status === 200, 'Deactivating 2nd admin succeeds when another active admin exists (200)');

        // Try deactivating the 2nd admin when it is already inactive or demoting the last active main admin
        const deactMainAdminAgain = await request(`/api/users/${adminUser._id}/status`, {
            method: 'PATCH',
            token: adminToken,
            body: { status: 'inactive' }
        });
        assert(deactMainAdminAgain.status === 400, 'Remaining sole active admin still cannot be deactivated (400)');

        // Clean up 2nd admin
        await User.findByIdAndDelete(secondAdmin._id);
    }

    console.log('\n--- 9. Permanent Deletion Refusal ---');
    {
        const dummyUser = await User.create({
            username: 'test_p2_6_dummy_del',
            email: 'dummy_del@school.test',
            role: 'teacher',
            status: 'active'
        });

        const delRes = await request(`/api/users/${dummyUser._id}`, {
            method: 'DELETE',
            token: adminToken
        });
        assert(delRes.status === 400, 'DELETE /api/users/:id refuses permanent deletion and recommends deactivation (400)');

        // Verify dummyUser is still in database
        const stillInDb = await User.findById(dummyUser._id);
        assert(!!stillInDb, 'User record preserved intact in database');
    }

    console.log('\n--- 10. Filters & ReDoS-Safe Search ---');
    {
        // Role filter
        const teachersOnly = await request('/api/users?role=teacher', { token: adminToken });
        assert(teachersOnly.status === 200, 'GET /api/users?role=teacher returns 200');
        const allAreTeachers = teachersOnly.data.every(u => u.role === 'teacher');
        assert(allAreTeachers, 'All returned users in filtered list have role teacher');

        // Status filter
        const activeOnly = await request('/api/users?status=active', { token: adminToken });
        assert(activeOnly.status === 200, 'GET /api/users?status=active returns 200');
        const allAreActive = activeOnly.data.every(u => u.status === 'active');
        assert(allAreActive, 'All returned users in filtered list have status active');

        // Search filter with regex special characters (ReDoS test)
        const reDosSearch = await request('/api/users?search=.*+?^${}()|[]\\', { token: adminToken });
        assert(reDosSearch.status === 200, 'Search with regex special characters is escaped and returns 200 without crashing');

        // Valid search matching admin
        const adminSearch = await request('/api/users?search=admin@gmail.com', { token: adminToken });
        assert(adminSearch.status === 200 && adminSearch.data.length >= 1, 'Search for admin email returns matching user');
    }

    console.log('\n--- 11. Student IDOR & Private Record Protection with Explicit Linkage ---');
    {
        // testStudent has id_number: 'P2_6_STU_001'
        // studentUser is linked explicitly via student_id: testStudent._id
        // Create a 2nd student in DB
        let studentB = await Student.findOne({ id_number: 'P2_6_STU_002' });
        if (!studentB) {
            studentB = await Student.create({
                full_name: 'P2_6 Student B',
                id_number: 'P2_6_STU_002',
                class_name: 'GRADE 10',
                gender: 'Female',
                contact: '999-888-7777'
            });
        }

        // Student A requesting their own report
        const ownReport = await request(`/api/reports/student/${testStudent._id}`, { token: studentToken });
        assert(ownReport.status === 200, 'Student can view their own report (200)');

        // Student A requesting Student B's report -> 403
        const otherReport = await request(`/api/reports/student/${studentB._id}`, { token: studentToken });
        assert(otherReport.status === 403, 'Student cannot view another student report (403)');

        // Student A requesting GET /api/students -> only sees own record
        const stuList = await request('/api/students', { token: studentToken });
        assert(stuList.status === 200, 'Student GET /api/students succeeds (200)');
        assert(stuList.data.length === 1 && stuList.data[0].id === testStudent._id.toString(), 'Student only sees their own student record');
    }

    console.log('\n--- 12. OTP Authentication Flow ---');
    {
        const otpUser = await User.create({
            username: 'test_p2_6_otp_flow',
            email: 'otp_flow@school.test',
            role: 'teacher',
            status: 'active'
        });

        const sendRes = await request('/api/send-otp', {
            method: 'POST',
            body: { email: 'otp_flow@school.test' }
        });
        assert(sendRes.status === 200, 'POST /api/send-otp succeeds for active user (200)');

        // Read OTP from user in DB
        const userWithOtp = await User.findById(otpUser._id).select('+otp +otpExpires');
        assert(!!userWithOtp.otp && !!userWithOtp.otpExpires, 'OTP and otpExpires stored in DB');

        // Cannot verify wrong code
        const wrongVerify = await request('/api/verify-otp', {
            method: 'POST',
            body: { email: 'otp_flow@school.test', otp: '000000' }
        });
        assert(wrongVerify.status === 401, 'POST /api/verify-otp rejects invalid code (401)');
    }
    } finally {
        // Guaranteed cleanup of test data created during this suite regardless of outcome
        await User.deleteMany({ username: { $regex: /^test_p2_6_/ } });
        await Student.deleteMany({ id_number: { $regex: /^P2_6_STU_/ } });
        await Teacher.deleteMany({ name: /^P2_6/ });
        await mongoose.disconnect();
    }

    console.log('\n====================================================');
    console.log(`P2 #6 TEST SUITE COMPLETED: ${passed} PASSED, ${failed} FAILED`);
    console.log('====================================================');

    process.exit(failed > 0 ? 1 : 0);
}

runTests().catch(err => {
    console.error('Test suite error:', err);
    process.exit(1);
});
