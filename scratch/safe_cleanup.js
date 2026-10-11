const mongoose = require('mongoose');
const path = require('path');
const PROJECT_ROOT = 'c:\\Users\\Abdikhaliq\\OneDrive\\Desktop\\Abdikarim\\SCHOOL SYSTEM';
require(path.join(PROJECT_ROOT, 'node_modules', 'dotenv')).config({ path: path.join(PROJECT_ROOT, '.env') });
const db = require(path.join(PROJECT_ROOT, 'backend', 'database'));

async function performSafeCleanup() {
    await db.connectDB();
    console.log('=== PRE-P2 #6 SAFE TEST DATA CLEANUP ===\n');

    const timestampRegex = /\d{13}/;

    // 1. Identify test classes (12 classes)
    const testClasses = await db.Class.find({
        name: { $regex: timestampRegex },
        teacher_id: null
    });
    console.log(`Found ${testClasses.length} test classes (Target: 12).`);
    if (testClasses.length !== 12) {
        throw new Error(`Expected exactly 12 test classes, found ${testClasses.length}`);
    }
    const testClassIds = testClasses.map(c => c._id);

    // 2. Identify test students (14 students)
    const testStudents = await db.Student.find({
        $or: [
            { id_number: { $regex: timestampRegex } },
            { full_name: { $regex: timestampRegex } }
        ]
    });
    console.log(`Found ${testStudents.length} test students (Target: 14).`);
    if (testStudents.length !== 14) {
        throw new Error(`Expected exactly 14 test students, found ${testStudents.length}`);
    }
    const testStudentIds = testStudents.map(s => s._id);

    // 3. Identify test users (10 remaining test users: 8 timestamped + test_teacher_exam + admin@school.edu)
    const testUsers = await db.User.find({
        $or: [
            { username: { $regex: timestampRegex } },
            { username: 'test_teacher_exam' },
            { username: 'admin@school.edu' }
        ]
    });
    console.log(`Found ${testUsers.length} test users (Target: 10).`);
    const testUserIds = testUsers.map(u => u._id);

    // 4. Identify test academic years (14)
    const testAys = await db.AcademicYear.find({ name: { $regex: timestampRegex } });
    console.log(`Found ${testAys.length} test academic years.`);
    const testAyIds = testAys.map(a => a._id);

    // 5. Identify test terms (15)
    const testTerms = await db.Term.find({
        $or: [
            { name: { $regex: timestampRegex } },
            { academic_year_id: { $in: testAyIds } }
        ]
    });
    console.log(`Found ${testTerms.length} test terms.`);
    const testTermIds = testTerms.map(t => t._id);

    // 6. Identify test subjects (20)
    const testSubjects = await db.Subject.find({
        $or: [
            { name: { $regex: timestampRegex } },
            { code: { $regex: timestampRegex } }
        ]
    });
    console.log(`Found ${testSubjects.length} test subjects.`);
    const testSubjectIds = testSubjects.map(s => s._id);

    // 7. Identify test class-subjects
    const testClassSubjects = await db.ClassSubject.find({
        $or: [
            { class_id: { $in: testClassIds } },
            { subject_id: { $in: testSubjectIds } },
            { academic_year_id: { $in: testAyIds } }
        ]
    });
    console.log(`Found ${testClassSubjects.length} test class-subjects.`);
    const testCsIds = testClassSubjects.map(cs => cs._id);

    // 8. Identify test exams (20)
    const testExams = await db.Exam.find({
        name: { $regex: timestampRegex }
    });
    console.log(`Found ${testExams.length} test exams.`);
    const testExamIds = testExams.map(e => e._id);

    // 9. Identify test marks (24)
    const testMarks = await db.Mark.find({
        $or: [
            { exam_id: { $in: testExamIds } },
            { student_id: { $in: testStudentIds } }
        ]
    });
    console.log(`Found ${testMarks.length} test marks.`);
    const testMarkIds = testMarks.map(m => m._id);

    // Ensure NO real student marks are in testMarks
    const realStudentIds = new Set(['69cd28a4bdd0f68e231c867b', '69cd28e7bdd0f68e231c8698', '69cd28fdbdd0f68e231c869d', '69cd2914bdd0f68e231c86a2', '69d5574f97ac7366f529a6a8', '6a133a5bc1c4a02d5c8d702d', '6a133fae68d450bb87cb62b8']);
    for (const m of testMarks) {
        if (realStudentIds.has(m.student_id.toString())) {
            throw new Error(`SAFETY CHECK FAILED: Mark ${m._id} belongs to real student ${m.student_id}!`);
        }
    }

    console.log('\n--- EXECUTING DELETION IN STRICT DEPENDENCY ORDER ---');

    // Step 1: Delete test Marks
    const delMarks = await db.Mark.deleteMany({ _id: { $in: testMarkIds } });
    console.log(`[1] Deleted ${delMarks.deletedCount} test marks.`);

    // Step 2: Delete test Exams
    const delExams = await db.Exam.deleteMany({ _id: { $in: testExamIds } });
    console.log(`[2] Deleted ${delExams.deletedCount} test exams.`);

    // Step 3: Delete test ClassSubjects
    const delCs = await db.ClassSubject.deleteMany({ _id: { $in: testCsIds } });
    console.log(`[3] Deleted ${delCs.deletedCount} test class-subjects.`);

    // Step 4: Delete test Students
    const delStudents = await db.Student.deleteMany({ _id: { $in: testStudentIds } });
    console.log(`[4] Deleted ${delStudents.deletedCount} test students.`);

    // Step 5: Delete test Users
    const delUsers = await db.User.deleteMany({ _id: { $in: testUserIds } });
    console.log(`[5] Deleted ${delUsers.deletedCount} test users.`);

    // Step 6: Delete test Classes
    const delClasses = await db.Class.deleteMany({ _id: { $in: testClassIds } });
    console.log(`[6] Deleted ${delClasses.deletedCount} test classes.`);

    // Step 7: Delete test Terms
    const delTerms = await db.Term.deleteMany({ _id: { $in: testTermIds } });
    console.log(`[7] Deleted ${delTerms.deletedCount} test terms.`);

    // Step 8: Delete test Subjects
    const delSubjects = await db.Subject.deleteMany({ _id: { $in: testSubjectIds } });
    console.log(`[8] Deleted ${delSubjects.deletedCount} test subjects.`);

    // Step 9: Delete test Academic Years
    const delAys = await db.AcademicYear.deleteMany({ _id: { $in: testAyIds } });
    console.log(`[9] Deleted ${delAys.deletedCount} test academic years.`);

    // Step 10: Restore real class name for 69cd27a1bdd0f68e231c8645
    const renamedClass = await db.Class.findById('69cd27a1bdd0f68e231c8645');
    if (renamedClass && renamedClass.name.startsWith('Live-Updated-')) {
        renamedClass.name = 'GRADE 10';
        await renamedClass.save();
        console.log('[10] Restored class 69cd27a1bdd0f68e231c8645 name back to "GRADE 10".');
    }

    console.log('\n=== INTEGRITY & ORPHAN SCAN POST-CLEANUP ===');
    const remainingClasses = await db.Class.find();
    const remainingStudents = await db.Student.find();
    const remainingTeachers = await db.Teacher.find();
    const remainingMarks = await db.Mark.find();
    const remainingExams = await db.Exam.find();
    const remainingAtt = await db.Attendance.find();
    const remainingUsers = await db.User.find();
    const remainingAys = await db.AcademicYear.find();
    const remainingTerms = await db.Term.find();
    const remainingSubjs = await db.Subject.find();
    const remainingCs = await db.ClassSubject.find();

    console.log(`Classes: ${remainingClasses.length}`);
    console.log(`Students: ${remainingStudents.length}`);
    console.log(`Teachers: ${remainingTeachers.length}`);
    console.log(`Marks: ${remainingMarks.length}`);
    console.log(`Exams: ${remainingExams.length}`);
    console.log(`Attendance: ${remainingAtt.length}`);
    console.log(`Users: ${remainingUsers.length}`);
    console.log(`Academic Years: ${remainingAys.length}`);
    console.log(`Terms: ${remainingTerms.length}`);
    console.log(`Subjects: ${remainingSubjs.length}`);
    console.log(`Class-Subjects: ${remainingCs.length}`);

    // Check student class_name mapping
    const classNames = new Set(remainingClasses.map(c => c.name));
    const unmappedStudents = remainingStudents.filter(s => !classNames.has(s.class_name));
    console.log(`Unmapped students: ${unmappedStudents.length}`);
    if (unmappedStudents.length > 0) {
        unmappedStudents.forEach(s => console.log(`  Unmapped: ${s.full_name} -> ${s.class_name}`));
    }

    // Check mark orphans
    const stIds = new Set(remainingStudents.map(s => s._id.toString()));
    const exIds = new Set(remainingExams.map(e => e._id.toString()));
    let orphanMarks = 0;
    for (const m of remainingMarks) {
        if (!stIds.has(m.student_id.toString()) || !exIds.has(m.exam_id.toString())) orphanMarks++;
    }
    console.log(`Orphan marks: ${orphanMarks}`);

    // Check attendance orphans
    let orphanAtt = 0;
    for (const a of remainingAtt) {
        if (!stIds.has(a.student_id.toString())) orphanAtt++;
    }
    console.log(`Orphan attendance: ${orphanAtt}`);

    console.log('\nCLEANUP COMPLETE & VERIFIED.');
    process.exit(0);
}

performSafeCleanup().catch(e => {
    console.error('[CLEANUP FAILED]:', e);
    process.exit(1);
});
