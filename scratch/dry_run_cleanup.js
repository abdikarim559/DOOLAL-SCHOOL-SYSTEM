const mongoose = require('mongoose');
const path = require('path');
const PROJECT_ROOT = 'c:\\Users\\Abdikhaliq\\OneDrive\\Desktop\\Abdikarim\\SCHOOL SYSTEM';
require(path.join(PROJECT_ROOT, 'node_modules', 'dotenv')).config({ path: path.join(PROJECT_ROOT, '.env') });
const db = require(path.join(PROJECT_ROOT, 'backend', 'database'));

async function dryRunCleanup() {
    await db.connectDB();
    console.log('=== DRY RUN: TEST DATA IDENTIFICATION ===\n');

    const timestampRegex = /\b\d{13}\b/;

    // 1. Identify 12 timestamp-suffixed test classes
    const testClasses = await db.Class.find({ name: { $regex: timestampRegex }, teacher_id: null });
    console.log(`[1] Test Classes (${testClasses.length} found - target: 12):`);
    testClasses.forEach(c => console.log(`    - ID: ${c._id} | Name: "${c.name}"`));
    const testClassIds = new Set(testClasses.map(c => c._id.toString()));

    // 2. Identify 11 test user accounts (1 already removed in Fix #1, so 10 remaining)
    const testUsers = await db.User.find({
        $or: [
            { username: { $regex: timestampRegex } },
            { username: 'test_teacher_exam' },
            { username: 'admin@school.edu' }
        ]
    });
    console.log(`\n[2] Test User Accounts (${testUsers.length} found):`);
    testUsers.forEach(u => console.log(`    - ID: ${u._id} | Username: "${u.username}" | Email: "${u.email}" | Role: ${u.role}`));
    const testUserIds = new Set(testUsers.map(u => u._id.toString()));

    // 3. Identify test students (14 timestamped test students)
    const testStudents = await db.Student.find({
        $or: [
            { id_number: { $regex: timestampRegex } },
            { full_name: { $regex: timestampRegex } }
        ]
    });
    console.log(`\n[3] Test Students (${testStudents.length} found):`);
    testStudents.forEach(s => console.log(`    - ID: ${s._id} | ID Num: "${s.id_number}" | Name: "${s.full_name}" | Class: "${s.class_name}"`));
    const testStudentIds = new Set(testStudents.map(s => s._id.toString()));

    // 4. Identify test academic years, terms, subjects
    const testAys = await db.AcademicYear.find({ name: { $regex: timestampRegex } });
    console.log(`\n[4] Test Academic Years (${testAys.length} found):`);
    testAys.forEach(a => console.log(`    - ID: ${a._id} | Name: "${a.name}"`));
    const testAyIds = new Set(testAys.map(a => a._id.toString()));

    const testTerms = await db.Term.find({
        $or: [
            { name: { $regex: timestampRegex } },
            { academic_year_id: { $in: Array.from(testAyIds) } }
        ]
    });
    console.log(`\n[5] Test Terms (${testTerms.length} found):`);
    testTerms.forEach(t => console.log(`    - ID: ${t._id} | Name: "${t.name}" | AY: ${t.academic_year_id}`));
    const testTermIds = new Set(testTerms.map(t => t._id.toString()));

    const testSubjects = await db.Subject.find({
        $or: [
            { name: { $regex: timestampRegex } },
            { code: { $regex: timestampRegex } }
        ]
    });
    console.log(`\n[6] Test Subjects (${testSubjects.length} found):`);
    testSubjects.forEach(s => console.log(`    - ID: ${s._id} | Name: "${s.name}" | Code: "${s.code}"`));
    const testSubjectIds = new Set(testSubjects.map(s => s._id.toString()));

    // 5. Identify test class-subjects
    const testClassSubjects = await db.ClassSubject.find({
        $or: [
            { class_id: { $in: Array.from(testClassIds) } },
            { subject_id: { $in: Array.from(testSubjectIds) } },
            { academic_year_id: { $in: Array.from(testAyIds) } }
        ]
    });
    console.log(`\n[7] Test Class-Subjects (${testClassSubjects.length} found):`);
    testClassSubjects.forEach(cs => console.log(`    - ID: ${cs._id} | Class: ${cs.class_id} | Subj: ${cs.subject_id} | AY: ${cs.academic_year_id}`));
    const testCsIds = new Set(testClassSubjects.map(cs => cs._id.toString()));

    // 6. Identify test exams
    const testExams = await db.Exam.find({
        $or: [
            { name: { $regex: timestampRegex } },
            { class_id: { $in: Array.from(testClassIds) } },
            { term_id: { $in: Array.from(testTermIds) } },
            { subject_id: { $in: Array.from(testSubjectIds) } }
        ]
    });
    console.log(`\n[8] Test Exams (${testExams.length} found):`);
    testExams.forEach(e => console.log(`    - ID: ${e._id} | Name: "${e.name}" | Total: ${e.total_marks}`));
    const testExamIds = new Set(testExams.map(e => e._id.toString()));

    // 7. Identify test marks
    const testMarks = await db.Mark.find({
        $or: [
            { exam_id: { $in: Array.from(testExamIds) } },
            { student_id: { $in: Array.from(testStudentIds) } }
        ]
    });
    console.log(`\n[9] Test Marks (${testMarks.length} found):`);
    testMarks.forEach(m => console.log(`    - ID: ${m._id} | Exam: ${m.exam_id} | Student: ${m.student_id} | Obtained: ${m.marks_obtained}`));

    // 8. Real school data to preserve verification
    console.log('\n=== REAL DATA TO PRESERVE (CONFIRMED) ===');
    const realStudents = await db.Student.find({ _id: { $nin: Array.from(testStudentIds) } });
    console.log(`Real Students (${realStudents.length} - should be 7):`);
    realStudents.forEach(s => console.log(`  * ${s.id_number}: ${s.full_name} (${s.class_name})`));

    const realClasses = await db.Class.find({ _id: { $nin: Array.from(testClassIds) } });
    console.log(`Real Classes (${realClasses.length} - should be 5):`);
    realClasses.forEach(c => console.log(`  * ${c._id}: "${c.name}"`));

    const realTeachers = await db.Teacher.find();
    console.log(`Real Teachers (${realTeachers.length} - should be 6):`);
    realTeachers.forEach(t => console.log(`  * ${t._id}: ${t.name}`));

    const realAttendance = await db.Attendance.find();
    console.log(`Real Attendance Records (${realAttendance.length} - should be 14):`);
    realAttendance.forEach(a => console.log(`  * ${a._id}: Student ${a.student_id} on ${a.date} (${a.status})`));

    const realUsers = await db.User.find({ _id: { $nin: Array.from(testUserIds) } });
    console.log(`Real Users (${realUsers.length}):`);
    realUsers.forEach(u => console.log(`  * ${u._id}: ${u.username} (${u.role}) email=${u.email}`));

    process.exit(0);
}

dryRunCleanup().catch(e => { console.error(e); process.exit(1); });
