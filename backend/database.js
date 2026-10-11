const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');
const logger = require('./utils/logger');

const connectDB = async () => {
    if (!process.env.MONGO_URI) {
        logger.error('[CONFIG ERROR] MONGO_URI environment variable is missing.');
        process.exit(1);
    }
    try {
        await mongoose.connect(process.env.MONGO_URI);
        logger.info('Connected to MongoDB.');
        initDB();
    } catch (err) {
        logger.error('Error connecting to database:', { error: err.message, category: 'connection_failure' });
        process.exit(1);
    }
};

mongoose.connection.on('error', (err) => {
    logger.error('[DATABASE ERROR] Mongoose connection error:', { error: err.message, category: 'connection_error' });
});

mongoose.connection.on('disconnected', () => {
    logger.warn('[DATABASE WARNING] Mongoose disconnected from MongoDB.', { category: 'connection_lost' });
});

const userSchema = new mongoose.Schema({
    username: { type: String, unique: true, required: true, trim: true },
    email: { type: String, unique: true, sparse: true, trim: true, lowercase: true },
    // SECURITY: select:false — password is never returned in default queries
    password: { type: String, required: false, select: false },
    // SECURITY: role enum — only known roles can be stored; prevents arbitrary role injection
    role: { type: String, required: true, enum: ['admin', 'teacher', 'student'] },
    // Account status: active/inactive (inactive accounts cannot authenticate)
    status: { type: String, enum: ['active', 'inactive'], default: 'active' },
    // Explicit entity linkages for student and teacher roles
    student_id: { type: mongoose.Schema.Types.ObjectId, ref: 'Student', default: null },
    teacher_id: { type: mongoose.Schema.Types.ObjectId, ref: 'Teacher', default: null },
    otp: { type: String, select: false },
    otpExpires: { type: Date, select: false }
}, { timestamps: true });

const studentSchema = new mongoose.Schema({
    full_name: String,
    id_number: { type: String, unique: true },
    class_name: String,
    gender: { type: String, enum: ['Male', 'Female'] },
    contact: String
}, { timestamps: true });

const teacherSchema = new mongoose.Schema({
    name: String,
    subject: String,
    phone: String
}, { timestamps: true });

const classSchema = new mongoose.Schema({
    name: { type: String, unique: true },
    teacher_id: { type: mongoose.Schema.Types.ObjectId, ref: 'Teacher', default: null }
}, { timestamps: true });

const attendanceSchema = new mongoose.Schema({
    student_id: { type: mongoose.Schema.Types.ObjectId, ref: 'Student', required: true },
    date: { type: String, required: true },
    status: { type: String, enum: ['Present', 'Absent', 'Late', 'Excused'], required: true }
}, { timestamps: true });

// Compound unique index: prevents duplicate attendance for the same student on the same date
attendanceSchema.index({ student_id: 1, date: 1 }, { unique: true });

const User = mongoose.model('User', userSchema);
const Student = mongoose.model('Student', studentSchema);
const Teacher = mongoose.model('Teacher', teacherSchema);
const Class = mongoose.model('Class', classSchema);
const Attendance = mongoose.model('Attendance', attendanceSchema);

// ---------------------------------------------------------------------------
// ACADEMIC FOUNDATION SCHEMAS & MODELS (P2 #1)
// ---------------------------------------------------------------------------

// 1. Academic Year Schema
const academicYearSchema = new mongoose.Schema({
    name: { type: String, required: true, unique: true, trim: true },
    start_date: { type: String, required: true, trim: true },
    end_date: { type: String, required: true, trim: true },
    status: { type: String, required: true, enum: ['active', 'closed'], default: 'active' }
}, { timestamps: true });

// 2. Term Schema
const termSchema = new mongoose.Schema({
    name: { type: String, required: true, trim: true },
    academic_year_id: { type: mongoose.Schema.Types.ObjectId, ref: 'AcademicYear', required: true },
    start_date: { type: String, required: true, trim: true },
    end_date: { type: String, required: true, trim: true },
    status: { type: String, required: true, enum: ['active', 'closed'], default: 'active' }
}, { timestamps: true });

// Compound unique index: duplicate term names within the same academic year are prevented
termSchema.index({ academic_year_id: 1, name: 1 }, { unique: true });

// 3. Subject Schema
const subjectSchema = new mongoose.Schema({
    name: { type: String, required: true, trim: true },
    code: { type: String, required: true, unique: true, uppercase: true, trim: true },
    description: { type: String, default: '', trim: true },
    status: { type: String, required: true, enum: ['active', 'inactive'], default: 'active' }
}, { timestamps: true });

// 4. ClassSubject Schema (Assignment of Subject to Class within Academic Year)
const classSubjectSchema = new mongoose.Schema({
    class_id: { type: mongoose.Schema.Types.ObjectId, ref: 'Class', required: true },
    subject_id: { type: mongoose.Schema.Types.ObjectId, ref: 'Subject', required: true },
    academic_year_id: { type: mongoose.Schema.Types.ObjectId, ref: 'AcademicYear', required: true },
    teacher_id: { type: mongoose.Schema.Types.ObjectId, ref: 'Teacher', default: null },
    status: { type: String, enum: ['active', 'inactive'], default: 'active' }
}, { timestamps: true });

// Compound unique index: prevents duplicate class + subject + academic_year
classSubjectSchema.index({ class_id: 1, subject_id: 1, academic_year_id: 1 }, { unique: true });

const AcademicYear = mongoose.model('AcademicYear', academicYearSchema);
const Term = mongoose.model('Term', termSchema);
const Subject = mongoose.model('Subject', subjectSchema);
const ClassSubject = mongoose.model('ClassSubject', classSubjectSchema);

// ---------------------------------------------------------------------------
// EXAM MANAGEMENT SCHEMA & MODEL (P2 #2)
// ---------------------------------------------------------------------------
const examSchema = new mongoose.Schema({
    name: { type: String, required: true, trim: true, maxlength: 100 },
    type: {
        type: String,
        required: true,
        enum: ['Midterm', 'Final', 'Quiz', 'Assignment', 'Other']
    },
    academic_year_id: { type: mongoose.Schema.Types.ObjectId, ref: 'AcademicYear', required: true },
    term_id: { type: mongoose.Schema.Types.ObjectId, ref: 'Term', required: true },
    class_id: { type: mongoose.Schema.Types.ObjectId, ref: 'Class', required: true },
    subject_id: { type: mongoose.Schema.Types.ObjectId, ref: 'Subject', required: true },
    exam_date: { type: String, required: true, trim: true },
    total_marks: { type: Number, required: true, min: 1 },
    status: { type: String, enum: ['active', 'inactive'], default: 'active' }
}, { timestamps: true });

// Compound unique index: prevents duplicate exam name for the same academic year + term + class + subject
examSchema.index({ academic_year_id: 1, term_id: 1, class_id: 1, subject_id: 1, name: 1 }, { unique: true });

const Exam = mongoose.model('Exam', examSchema);

// ---------------------------------------------------------------------------
// MARKS MANAGEMENT SCHEMA & MODEL (P2 #3)
// ---------------------------------------------------------------------------
const markSchema = new mongoose.Schema({
    exam_id: { type: mongoose.Schema.Types.ObjectId, ref: 'Exam', required: true },
    student_id: { type: mongoose.Schema.Types.ObjectId, ref: 'Student', required: true },
    marks_obtained: { type: Number, required: true, min: 0 },
    remarks: { type: String, default: '', trim: true, maxlength: 500 }
}, { timestamps: true });

// Compound unique index: prevents duplicate marks for the same student in the same exam
markSchema.index({ exam_id: 1, student_id: 1 }, { unique: true });

const Mark = mongoose.model('Mark', markSchema);

// ---------------------------------------------------------------------------
// SCHOOL OPERATIONS SCHEMAS & MODELS (P3 PACKAGE A)
// ---------------------------------------------------------------------------

// 1. School Profile & Operational Settings Schema (Singleton Model)
const settingSchema = new mongoose.Schema({
    school_name: { type: String, default: 'DOOLAL SCHOOL', trim: true, maxlength: 120 },
    school_motto: { type: String, default: 'Excellence in Education', trim: true, maxlength: 200 },
    school_address: { type: String, default: 'Mogadishu, Somalia', trim: true, maxlength: 300 },
    school_phone: { type: String, default: '+252 61 0000000', trim: true, maxlength: 50 },
    school_email: { type: String, default: 'admin@school.edu', trim: true, lowercase: true, maxlength: 120 },
    logo_url: { type: String, default: '', trim: true, maxlength: 500 },
    min_attendance_percent: { type: Number, default: 75, min: 0, max: 100 },
    default_academic_year_id: { type: mongoose.Schema.Types.ObjectId, ref: 'AcademicYear', default: null },
    default_term_id: { type: mongoose.Schema.Types.ObjectId, ref: 'Term', default: null }
}, { timestamps: true });

// 2. Timetable / Class Schedule Schema
const timetableSlotSchema = new mongoose.Schema({
    class_id: { type: mongoose.Schema.Types.ObjectId, ref: 'Class', required: true },
    subject_id: { type: mongoose.Schema.Types.ObjectId, ref: 'Subject', required: true },
    teacher_id: { type: mongoose.Schema.Types.ObjectId, ref: 'Teacher', required: true },
    academic_year_id: { type: mongoose.Schema.Types.ObjectId, ref: 'AcademicYear', required: true },
    day_of_week: {
        type: String,
        required: true,
        enum: ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday']
    },
    start_time: { type: String, required: true, trim: true }, // 'HH:MM' (24-hour)
    end_time: { type: String, required: true, trim: true },   // 'HH:MM' (24-hour)
    room_number: { type: String, default: '', trim: true, maxlength: 50 },
    status: { type: String, enum: ['active', 'inactive'], default: 'active' }
}, { timestamps: true });

timetableSlotSchema.index({ class_id: 1, day_of_week: 1, status: 1 });
timetableSlotSchema.index({ teacher_id: 1, day_of_week: 1, status: 1 });

// 3. Notice Board & Announcements Schema
const noticeSchema = new mongoose.Schema({
    title: { type: String, required: true, trim: true, maxlength: 150 },
    content: { type: String, required: true, trim: true, maxlength: 2000 },
    author_id: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    author_name: { type: String, default: 'Administration', trim: true, maxlength: 100 },
    target_role: { type: String, required: true, enum: ['all', 'teacher', 'student'], default: 'all' },
    priority: { type: String, required: true, enum: ['normal', 'urgent'], default: 'normal' },
    status: { type: String, enum: ['active', 'archived'], default: 'active' },
    expires_at: { type: Date, default: null }
}, { timestamps: true });

noticeSchema.index({ status: 1, target_role: 1, createdAt: -1 });

const Setting = mongoose.model('Setting', settingSchema);
const TimetableSlot = mongoose.model('TimetableSlot', timetableSlotSchema);
const Notice = mongoose.model('Notice', noticeSchema);

async function initDB() {
    try {
        const admin = await User.findOne({ username: 'admin' });
        if (!admin) {
            // SECURITY: Use ADMIN_INIT_PASSWORD env var for the initial admin password.
            // Set this in your .env file. If not set, a random secure password is used
            // and printed once to the console so you can log in and change it.
            const initPwd = process.env.ADMIN_INIT_PASSWORD;
            let pwdToHash;
            if (initPwd) {
                pwdToHash = initPwd;
            } else {
                // Generate a one-time password and print it so the admin can log in.
                const crypto = require('crypto');
                pwdToHash = crypto.randomBytes(16).toString('hex');
                console.warn(
                    '\n[SECURITY] ADMIN_INIT_PASSWORD is not set in .env.\n' +
                    `Generated one-time admin password: ${pwdToHash}\n` +
                    'Please log in immediately and set a strong password.\n'
                );
            }
            const salt = bcrypt.genSaltSync(12);
            const hash = bcrypt.hashSync(pwdToHash, salt);
            await User.create({ username: 'admin', email: 'admin@gmail.com', password: hash, role: 'admin' });
        }

        // Initialize default singleton settings if none exist
        const settingCount = await Setting.countDocuments();
        if (settingCount === 0) {
            await Setting.create({});
            logger.info('Initialized default school settings singleton.');
        }
    } catch(err) {
        logger.error('Error initializing database', { error: err.message, category: 'db_init_error' });
    }
}

module.exports = {
    connectDB,
    User,
    Student,
    Teacher,
    Class,
    Attendance,
    AcademicYear,
    Term,
    Subject,
    ClassSubject,
    Exam,
    Mark,
    Setting,
    TimetableSlot,
    Notice
};
