const mongoose = require('mongoose');
const path = require('path');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');

const PROJECT_ROOT = 'c:\\Users\\Abdikhaliq\\OneDrive\\Desktop\\Abdikarim\\SCHOOL SYSTEM';
require(path.join(PROJECT_ROOT, 'node_modules', 'dotenv')).config({ path: path.join(PROJECT_ROOT, '.env') });
const { User, connectDB } = require(path.join(PROJECT_ROOT, 'backend', 'database'));

async function fixAdminEmail() {
    await connectDB();
    console.log('[FIX #1] Connected to MongoDB.');

    // 1. Identify actual admin user
    const adminUser = await User.findOne({ username: 'admin' }).select('+password +otp +otpExpires');
    if (!adminUser) {
        console.error('[FIX #1 ERROR] No user with username "admin" found.');
        process.exit(1);
    }
    console.log(`[FIX #1] Found actual admin account: id=${adminUser._id}, username=${adminUser.username}, role=${adminUser.role}, email=${adminUser.email}`);

    if (adminUser.role !== 'admin') {
        console.error('[FIX #1 ERROR] Actual admin account does not have role "admin"!');
        process.exit(1);
    }

    // 2. Check configured admin email
    const targetEmail = 'admin@gmail.com';
    console.log(`[FIX #1] Target configured admin email: ${targetEmail}`);

    // Check if conflicting student account with this email exists
    const conflictingUser = await User.findOne({ email: targetEmail });
    if (conflictingUser && conflictingUser._id.toString() !== adminUser._id.toString()) {
        console.log(`[FIX #1] Found conflicting record: id=${conflictingUser._id}, username=${conflictingUser.username}, role=${conflictingUser.role}`);
        if (conflictingUser.role === 'student' && conflictingUser.username === 'admin@gmail.com') {
            console.log(`[FIX #1] Removing bogus student record holding ${targetEmail}...`);
            await User.deleteOne({ _id: conflictingUser._id });
            console.log('[FIX #1] Removed bogus student record.');
        } else {
            console.error('[FIX #1 ERROR] Conflicting user is not the expected bogus student record. Aborting.');
            process.exit(1);
        }
    }

    // 3. Set email on the actual admin user
    adminUser.email = targetEmail;
    await adminUser.save();
    console.log(`[FIX #1] Successfully updated admin account: id=${adminUser._id}, email=${adminUser.email}, role=${adminUser.role}`);

    // 4. Verification checks
    // a. Verify admin role remains admin
    const reloadedAdmin = await User.findOne({ username: 'admin' }).select('+password +otp +otpExpires');
    if (reloadedAdmin.role !== 'admin' || reloadedAdmin.email !== targetEmail) {
        throw new Error('Admin account verification failed');
    }
    console.log('[FIX #1 VERIFY] Admin role is still "admin": PASSED');
    console.log('[FIX #1 VERIFY] Admin email is "admin@gmail.com": PASSED');

    // b. Verify no duplicate admin account was created
    const allAdmins = await User.find({ role: 'admin' });
    if (allAdmins.length !== 1) {
        throw new Error(`Expected exactly 1 admin user, found ${allAdmins.length}`);
    }
    console.log(`[FIX #1 VERIFY] Total admin accounts in DB: ${allAdmins.length} (no duplicates): PASSED`);

    // c. Verify admin OTP flow & JWT generation
    const testOtp = '849201';
    const salt = bcrypt.genSaltSync(10);
    reloadedAdmin.otp = bcrypt.hashSync(testOtp, salt);
    reloadedAdmin.otpExpires = new Date(Date.now() + 5 * 60000);
    await reloadedAdmin.save();

    const otpUser = await User.findOne({ email: targetEmail }).select('+otp +otpExpires');
    if (!otpUser || !bcrypt.compareSync(testOtp, otpUser.otp)) {
        throw new Error('OTP verification against admin user failed');
    }
    console.log('[FIX #1 VERIFY] OTP correctly matches admin account in DB: PASSED');

    const token = jwt.sign({ id: otpUser._id, role: otpUser.role }, process.env.JWT_SECRET, { expiresIn: '1d' });
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    if (decoded.id !== otpUser._id.toString() || decoded.role !== 'admin') {
        throw new Error('JWT generation failed or role mismatch');
    }
    console.log(`[FIX #1 VERIFY] Admin JWT generated and verified: role=${decoded.role}: PASSED`);

    // Clean up test OTP
    reloadedAdmin.otp = undefined;
    reloadedAdmin.otpExpires = undefined;
    await reloadedAdmin.save();
    console.log('[FIX #1 VERIFY] Cleaned up test OTP: PASSED');

    await mongoose.disconnect();
    console.log('[FIX #1] COMPLETE & VERIFIED.');
}

fixAdminEmail().catch(err => {
    console.error('[FIX #1 FAILED]:', err);
    process.exit(1);
});
