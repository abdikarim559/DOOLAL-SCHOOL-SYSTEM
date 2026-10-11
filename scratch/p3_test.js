/**
 * DOOLAAL SCHOOL MANAGEMENT SYSTEM
 * P3 — School Operations Automated Test Suite (Package A)
 *
 * Covers:
 * 1. Enhanced Attendance Operations (Statuses, Batch Upsert, History, Class Summary, IDOR)
 * 2. School Profile & Operational Settings (Singleton, Admin-only, Validation, Non-admin 403)
 * 3. Timetable & Schedule Management (CRUD, Class Overlap 409, Teacher Overlap 409, Time Validation)
 * 4. Notice Board & Announcements (CRUD, Target Audience Filtering, Priority, Archive, RBAC)
 */

'use strict';

require('dotenv').config();
const mongoose = require('mongoose');
const jwt = require('jsonwebtoken');

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
    console.log('STARTING P3 PACKAGE A AUTOMATED TEST SUITE');
    console.log('====================================================\n');

    await mongoose.connect(process.env.MONGO_URI || 'mongodb://127.0.0.1:27017/school_management');
    const { User, Student, Teacher, Class, Subject, Attendance, Setting, TimetableSlot, Notice } = require('../backend/database');

    // 1. Setup Auth Tokens
    const adminUser = await User.findOne({ username: 'admin' });
    if (!adminUser) {
        console.error('Fatal: admin user not found in database');
        process.exit(1);
    }
    const adminToken = jwt.sign({ id: adminUser._id.toString(), role: 'admin' }, JWT_SECRET, { expiresIn: '1h' });

    // Ensure test student 1
    let student1 = await Student.findOne({ id_number: 'P3_TEST_STU_1' });
    if (!student1) {
        student1 = await Student.create({
            full_name: 'P3 Test Student 1',
            id_number: 'P3_TEST_STU_1',
            class_name: 'GRADE 10',
            gender: 'Female',
            contact: '123-456-7890'
        });
    }

    // Ensure test student 2
    let student2 = await Student.findOne({ id_number: 'P3_TEST_STU_2' });
    if (!student2) {
        student2 = await Student.create({
            full_name: 'P3 Test Student 2',
            id_number: 'P3_TEST_STU_2',
            class_name: 'GRADE 10',
            gender: 'Male',
            contact: '123-456-7891'
        });
    }

    // Ensure test student 1 user account for IDOR testing
    await User.deleteMany({ username: { $regex: /^test_p3_/ } });
    const studentUser1 = await User.create({
        username: 'test_p3_stu1_user',
        email: 'test_p3_stu1@school.test',
        role: 'student',
        student_id: student1._id,
        status: 'active'
    });
    const studentToken1 = jwt.sign({ id: studentUser1._id.toString(), role: 'student', student_id: student1._id.toString() }, JWT_SECRET, { expiresIn: '1h' });

    // Test Teacher
    let teacher1 = await Teacher.findOne({ name: 'P3 Test Teacher 1' });
    if (!teacher1) {
        teacher1 = await Teacher.create({
            name: 'P3 Test Teacher 1',
            subject: 'Mathematics',
            phone: '555-123-4567'
        });
    }
    const teacherUser1 = await User.create({
        username: 'test_p3_teach1_user',
        email: 'test_p3_teach1@school.test',
        role: 'teacher',
        teacher_id: teacher1._id,
        status: 'active'
    });
    let teacher2 = await Teacher.findOne({ name: 'P3 Test Teacher 2' });
    if (!teacher2) {
        teacher2 = await Teacher.create({
            name: 'P3 Test Teacher 2',
            subject: 'Science',
            phone: '555-987-6543'
        });
    }
    const teacherToken1 = jwt.sign({ id: teacherUser1._id.toString(), role: 'teacher', teacher_id: teacher1._id.toString() }, JWT_SECRET, { expiresIn: '1h' });

    // Test Class & Subject
    // Remove any null name or test classes from failed test
    await Class.deleteMany({ $or: [{ name: null }, { name: { $regex: /^P3 Test/ } }] });
    await Subject.deleteMany({ code: 'ALG-P3-101' });

    let class1 = await Class.create({
        name: 'P3 Test Class A'
    });
    let class2 = await Class.create({
        name: 'P3 Test Class B'
    });

    let subject1 = await Subject.create({
        name: 'P3 Test Algebra',
        code: 'ALG-P3-101',
        status: 'active'
    });

    // Clean any prior P3 test attendance, timetables, notices
    await Attendance.deleteMany({ student_id: { $in: [student1._id, student2._id] } });
    await TimetableSlot.deleteMany({ class_id: { $in: [class1._id, class2._id] } });
    await Notice.deleteMany({ title: { $regex: /^\[P3_TEST\]/ } });

    console.log('--- MODULE 1: ENHANCED ATTENDANCE OPERATIONS ---');

    // Test 1.1: Create attendance with status Late and Excused
    const attLateRes = await request('/api/attendance', {
        method: 'POST',
        token: teacherToken1,
        body: {
            student_id: student1._id.toString(),
            date: '2026-10-15',
            status: 'Late',
            notes: 'Traffic delay'
        }
    });
    assert(attLateRes.status === 201 && attLateRes.data.status === 'Late', 'POST /api/attendance accepts "Late" status', JSON.stringify(attLateRes.data));

    const attExcusedRes = await request('/api/attendance', {
        method: 'POST',
        token: teacherToken1,
        body: {
            student_id: student2._id.toString(),
            date: '2026-10-15',
            status: 'Excused',
            notes: 'Medical leave'
        }
    });
    assert(attExcusedRes.status === 201 && attExcusedRes.data.status === 'Excused', 'POST /api/attendance accepts "Excused" status', JSON.stringify(attExcusedRes.data));

    // Test 1.2: Invalid status rejected
    const attInvalidRes = await request('/api/attendance', {
        method: 'POST',
        token: teacherToken1,
        body: {
            student_id: student1._id.toString(),
            date: '2026-10-16',
            status: 'HalfDay'
        }
    });
    assert(attInvalidRes.status === 400, 'POST /api/attendance rejects invalid status "HalfDay" (400)');

    // Test 1.3: Batch attendance upsert
    const batchRes = await request('/api/attendance/batch', {
        method: 'POST',
        token: teacherToken1,
        body: {
            date: '2026-10-17',
            class_name: 'GRADE 10',
            records: [
                { student_id: student1._id.toString(), status: 'Present' },
                { student_id: student2._id.toString(), status: 'Absent' }
            ]
        }
    });
    assert(batchRes.status === 200 && batchRes.data.updated_count === 2, 'POST /api/attendance/batch successfully processes batch upsert', JSON.stringify(batchRes.data));

    // Test 1.4: PUT /api/attendance/:id updates record
    const attLateId = attLateRes.data._id;
    const attPutRes = await request(`/api/attendance/${attLateId}`, {
        method: 'PUT',
        token: teacherToken1,
        body: {
            status: 'Present',
            notes: 'Updated to Present upon review'
        }
    });
    assert(attPutRes.status === 200 && attPutRes.data.status === 'Present', 'PUT /api/attendance/:id updates attendance status to Present');

    // Test 1.5: Student attendance history
    const historyRes = await request(`/api/attendance/student/${student1._id.toString()}`, {
        token: teacherToken1
    });
    assert(
        historyRes.status === 200 &&
        historyRes.data.summary.total_records >= 2 &&
        typeof historyRes.data.summary.attendance_rate_percent === 'number',
        'GET /api/attendance/student/:id returns history and attendance rate %',
        JSON.stringify(historyRes.data.summary)
    );

    // Test 1.6: Student IDOR protection: student1 can view their own, but NOT student2
    const studentOwnRes = await request(`/api/attendance/student/${student1._id.toString()}`, {
        token: studentToken1
    });
    assert(studentOwnRes.status === 200, 'Student can view own attendance history');

    const studentIdorRes = await request(`/api/attendance/student/${student2._id.toString()}`, {
        token: studentToken1
    });
    assert(studentIdorRes.status === 403, 'Student cannot view another student\'s attendance history (403 IDOR prevention)');

    // Test 1.7: Class date-range summary
    const classSummaryRes = await request(`/api/attendance/summary/class/${encodeURIComponent('GRADE 10')}?startDate=2026-10-01&endDate=2026-10-31`, {
        token: teacherToken1
    });
    assert(
        classSummaryRes.status === 200 &&
        classSummaryRes.data.total_records >= 2 &&
        typeof classSummaryRes.data.attendance_rate_percent === 'number',
        'GET /api/attendance/summary/class/:classId returns class date-range summary',
        JSON.stringify(classSummaryRes.data)
    );

    console.log('\n--- MODULE 2: SCHOOL PROFILE & OPERATIONAL SETTINGS ---');

    // Test 2.1: GET /api/settings
    const getSettingsRes = await request('/api/settings', {
        token: teacherToken1
    });
    assert(getSettingsRes.status === 200 && getSettingsRes.data.school_name, 'GET /api/settings returns settings object', JSON.stringify(getSettingsRes.data));

    // Test 2.2: PUT /api/settings as admin
    const updateSettingsRes = await request('/api/settings', {
        method: 'PUT',
        token: adminToken,
        body: {
            school_name: 'Doolaal Academy International',
            motto: 'Excellence in Education & Character',
            official_email: 'info@doolaal.edu',
            phone: '+252 61 5000000',
            address: 'KM4, Mogadishu, Somalia',
            logo_url: 'https://doolaal.edu/logo.png',
            min_attendance_percent: 75
        }
    });
    assert(
        updateSettingsRes.status === 200 &&
        updateSettingsRes.data.school_name === 'Doolaal Academy International' &&
        updateSettingsRes.data.min_attendance_percent === 75,
        'PUT /api/settings allows admin to update school profile and operational thresholds'
    );

    // Test 2.3: Non-admin rejected from PUT /api/settings (403)
    const teacherUpdateSettingsRes = await request('/api/settings', {
        method: 'PUT',
        token: teacherToken1,
        body: { school_name: 'Hacked School' }
    });
    assert(teacherUpdateSettingsRes.status === 403, 'PUT /api/settings forbids non-admin update (403)');

    // Test 2.4: Validation on invalid threshold
    const invalidSettingsRes = await request('/api/settings', {
        method: 'PUT',
        token: adminToken,
        body: { min_attendance_percent: 150 }
    });
    assert(invalidSettingsRes.status === 400, 'PUT /api/settings rejects min_attendance_percent > 100 (400)');

    console.log('\n--- MODULE 3: TIMETABLE & CLASS SCHEDULE MANAGEMENT ---');

    // Test 3.1: Create valid timetable slot
    const slot1Res = await request('/api/timetable', {
        method: 'POST',
        token: adminToken,
        body: {
            class_id: class1._id.toString(),
            subject_id: subject1._id.toString(),
            teacher_id: teacher1._id.toString(),
            day_of_week: 'Monday',
            start_time: '08:00',
            end_time: '09:00',
            room: 'P3-101'
        }
    });
    assert(slot1Res.status === 201 && slot1Res.data._id, 'POST /api/timetable creates timetable slot', JSON.stringify(slot1Res.data));
    const slot1Id = slot1Res.data._id;

    // Test 3.2: Invalid time ordering (end_time <= start_time)
    const badTimeRes = await request('/api/timetable', {
        method: 'POST',
        token: adminToken,
        body: {
            class_id: class2._id.toString(),
            subject_id: subject1._id.toString(),
            teacher_id: teacher1._id.toString(),
            day_of_week: 'Monday',
            start_time: '10:00',
            end_time: '09:30',
            room: 'P3-102'
        }
    });
    assert(badTimeRes.status === 400, 'POST /api/timetable rejects end_time <= start_time (400)');

    // Test 3.3: Class clash detection: another slot for class1 overlapping (08:30 - 09:30) with different teacher
    const classClashRes = await request('/api/timetable', {
        method: 'POST',
        token: adminToken,
        body: {
            class_id: class1._id.toString(),
            subject_id: subject1._id.toString(),
            teacher_id: teacher2._id.toString(),
            day_of_week: 'Monday',
            start_time: '08:30',
            end_time: '09:30',
            room: 'P3-103'
        }
    });
    assert(classClashRes.status === 409 && classClashRes.data.conflict_type === 'class', 'POST /api/timetable detects class schedule clash (409 Conflict)', JSON.stringify(classClashRes.data));

    // Test 3.4: Teacher clash detection: same teacher assigned to class2 during overlapping time (08:00 - 09:00)
    const teacherClashRes = await request('/api/timetable', {
        method: 'POST',
        token: adminToken,
        body: {
            class_id: class2._id.toString(),
            subject_id: subject1._id.toString(),
            teacher_id: teacher1._id.toString(),
            day_of_week: 'Monday',
            start_time: '08:15',
            end_time: '09:15',
            room: 'P3-102'
        }
    });
    assert(teacherClashRes.status === 409 && teacherClashRes.data.conflict_type === 'teacher', 'POST /api/timetable detects teacher schedule clash (409 Conflict)');

    // Test 3.5: Non-overlapping slot succeeds (09:15 - 10:15)
    const slot2Res = await request('/api/timetable', {
        method: 'POST',
        token: adminToken,
        body: {
            class_id: class1._id.toString(),
            subject_id: subject1._id.toString(),
            teacher_id: teacher1._id.toString(),
            day_of_week: 'Monday',
            start_time: '09:15',
            end_time: '10:15',
            room: 'P3-101'
        }
    });
    assert(slot2Res.status === 201, 'POST /api/timetable accepts non-overlapping slot');
    const slot2Id = slot2Res.data._id;

    // Test 3.6: GET /api/timetable filters
    const classTimetableRes = await request(`/api/timetable?class_id=${class1._id.toString()}`, {
        token: teacherToken1
    });
    assert(classTimetableRes.status === 200 && classTimetableRes.data.length >= 2, 'GET /api/timetable?class_id=... returns class slots');

    // Test 3.7: PUT /api/timetable/:id updates slot (without self-conflict)
    const updateSlotRes = await request(`/api/timetable/${slot1Id}`, {
        method: 'PUT',
        token: adminToken,
        body: {
            room: 'Lab-A'
        }
    });
    assert(updateSlotRes.status === 200 && updateSlotRes.data.room === 'Lab-A', 'PUT /api/timetable/:id updates slot safely without self-conflict');

    // Test 3.8: DELETE /api/timetable/:id
    const deleteSlotRes = await request(`/api/timetable/${slot2Id}`, {
        method: 'DELETE',
        token: adminToken
    });
    assert(deleteSlotRes.status === 200, 'DELETE /api/timetable/:id removes timetable slot');

    // Test 3.9: Non-admin RBAC
    const teacherDeleteRes = await request(`/api/timetable/${slot1Id}`, {
        method: 'DELETE',
        token: teacherToken1
    });
    assert(teacherDeleteRes.status === 403, 'DELETE /api/timetable/:id forbids non-admin (403)');

    console.log('\n--- MODULE 4: NOTICE BOARD & ANNOUNCEMENTS ---');

    // Test 4.1: Create notices for all, teacher, and student
    const noticeAllRes = await request('/api/notices', {
        method: 'POST',
        token: adminToken,
        body: {
            title: '[P3_TEST] School Holiday Announcement',
            content: 'The school will be closed on Friday for national holiday.',
            target_role: 'all',
            priority: 'urgent'
        }
    });
    assert(noticeAllRes.status === 201 && noticeAllRes.data.priority === 'urgent', 'POST /api/notices creates urgent notice for "all"');
    const noticeAllId = noticeAllRes.data._id;

    const noticeTeacherRes = await request('/api/notices', {
        method: 'POST',
        token: adminToken,
        body: {
            title: '[P3_TEST] Staff Meeting',
            content: 'Faculty staff meeting on Monday at 3 PM in Conference Room.',
            target_role: 'teacher',
            priority: 'normal'
        }
    });
    assert(noticeTeacherRes.status === 201, 'POST /api/notices creates notice for "teacher"');
    const noticeTeacherId = noticeTeacherRes.data._id;

    const noticeStudentRes = await request('/api/notices', {
        method: 'POST',
        token: adminToken,
        body: {
            title: '[P3_TEST] Science Fair Submissions',
            content: 'Submit science fair proposals by next Wednesday.',
            target_role: 'student',
            priority: 'normal'
        }
    });
    assert(noticeStudentRes.status === 201, 'POST /api/notices creates notice for "student"');
    const noticeStudentId = noticeStudentRes.data._id;

    // Test 4.2: Role visibility checks
    // Student sees 'all' and 'student', but NOT 'teacher'
    const studentNotices = await request('/api/notices', { token: studentToken1 });
    assert(studentNotices.status === 200, 'Student can fetch active notices');
    const studentNoticeTitles = studentNotices.data.map(n => n.title);
    assert(
        studentNoticeTitles.includes('[P3_TEST] School Holiday Announcement') &&
        studentNoticeTitles.includes('[P3_TEST] Science Fair Submissions') &&
        !studentNoticeTitles.includes('[P3_TEST] Staff Meeting'),
        'Student notices include "all" and "student", strictly excluding "teacher" notices'
    );

    // Teacher sees 'all' and 'teacher', but NOT 'student'
    const teacherNotices = await request('/api/notices', { token: teacherToken1 });
    assert(teacherNotices.status === 200, 'Teacher can fetch active notices');
    const teacherNoticeTitles = teacherNotices.data.map(n => n.title);
    assert(
        teacherNoticeTitles.includes('[P3_TEST] School Holiday Announcement') &&
        teacherNoticeTitles.includes('[P3_TEST] Staff Meeting') &&
        !teacherNoticeTitles.includes('[P3_TEST] Science Fair Submissions'),
        'Teacher notices include "all" and "teacher", strictly excluding "student" notices'
    );

    // Admin sees all
    const adminNotices = await request('/api/notices', { token: adminToken });
    const adminNoticeTitles = adminNotices.data.map(n => n.title);
    assert(
        adminNoticeTitles.includes('[P3_TEST] School Holiday Announcement') &&
        adminNoticeTitles.includes('[P3_TEST] Staff Meeting') &&
        adminNoticeTitles.includes('[P3_TEST] Science Fair Submissions'),
        'Admin notices include all targets'
    );

    // Test 4.3: Archive toggle
    const archiveRes = await request(`/api/notices/${noticeTeacherId}/archive`, {
        method: 'PATCH',
        token: adminToken
    });
    assert(archiveRes.status === 200 && archiveRes.data.is_archived === true, 'PATCH /api/notices/:id/archive toggles is_archived');

    // Non-admin query should no longer include archived notice
    const teacherNoticesAfterArchive = await request('/api/notices', { token: teacherToken1 });
    const teacherTitlesAfter = teacherNoticesAfterArchive.data.map(n => n.title);
    assert(!teacherTitlesAfter.includes('[P3_TEST] Staff Meeting'), 'Archived notice is excluded from active listings for non-admins');

    // Test 4.4: Non-admin write permissions forbidden (403)
    const studentCreateNotice = await request('/api/notices', {
        method: 'POST',
        token: studentToken1,
        body: { title: 'Unauthorized', content: 'hack', target_role: 'all' }
    });
    assert(studentCreateNotice.status === 403, 'POST /api/notices forbids student creation (403)');

    // Test 4.5: Delete notice
    const deleteNoticeRes = await request(`/api/notices/${noticeAllId}`, {
        method: 'DELETE',
        token: adminToken
    });
    assert(deleteNoticeRes.status === 200, 'DELETE /api/notices/:id deletes notice successfully');

    console.log('\n--- CLEANUP OF TEST RECORDS ---');
    await Attendance.deleteMany({ student_id: { $in: [student1._id, student2._id] } });
    await TimetableSlot.deleteMany({ class_id: { $in: [class1._id, class2._id] } });
    await Notice.deleteMany({ title: { $regex: /^\[P3_TEST\]/ } });
    await User.deleteMany({ username: { $regex: /^test_p3_/ } });
    await Student.deleteMany({ id_number: { $in: ['P3_TEST_STU_1', 'P3_TEST_STU_2'] } });
    await Teacher.deleteMany({ name: { $in: ['P3 Test Teacher 1', 'P3 Test Teacher 2'] } });
    await Class.deleteMany({ name: { $in: ['P3 Test Class A', 'P3 Test Class B'] } });
    await Subject.deleteMany({ code: 'ALG-P3-101' });

    console.log('Cleanup completed safely.\n');
    console.log('====================================================');
    console.log(`P3 TEST RESULTS: ${passed} PASSED, ${failed} FAILED`);
    console.log('====================================================');

    await mongoose.disconnect();
    if (failed > 0) {
        process.exit(1);
    }
}

runTests().catch(err => {
    console.error('Fatal error running P3 test suite:', err);
    process.exit(1);
});
