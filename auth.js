// auth.js - FIXED: Robust initialization that handles CDN race conditions
const SUPABASE_URL = "https://ceorbsqwabgioxfcrqvv.supabase.co";
const SUPABASE_ANON_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImNlb3Jic3F3YWJnaW94ZmNycXZ2Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NTkzNDQ3OTMsImV4cCI6MjA3NDkyMDc5M30.rcmIGUIg1jeTXu0n6lc5Kpz3BLwmIzm2aOW4V6alOlU";

console.log('🏁 auth.js loading started...');

function loadScript(src) {
    return new Promise((resolve, reject) => {
        const existing = Array.from(document.getElementsByTagName('script')).find((script) => script.src === src);
        if (existing) {
            if (window.supabase && typeof window.supabase.createClient === 'function') {
                resolve();
                return;
            }
            existing.addEventListener('load', resolve, { once: true });
            existing.addEventListener('error', () => reject(new Error(`Failed to load script: ${src}`)), { once: true });
            return;
        }

        const script = document.createElement('script');
        script.src = src;
        script.async = true;
        script.onload = () => resolve();
        script.onerror = () => reject(new Error(`Failed to load script: ${src}`));
        document.head.appendChild(script);
    });
}

async function ensureSupabaseLibraryLoaded() {
    if (window.supabase && typeof window.supabase.createClient === 'function') {
        return;
    }

    const fallbackSources = [
        'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2',
        'https://unpkg.com/@supabase/supabase-js@2'
    ];

    for (const src of fallbackSources) {
        try {
            console.log(`🔄 Attempting Supabase script from: ${src}`);
            await loadScript(src);
            if (window.supabase && typeof window.supabase.createClient === 'function') {
                console.log('✅ Supabase library loaded successfully');
                return;
            }
        } catch (error) {
            console.warn(`⚠️ Supabase script load failed for ${src}:`, error.message);
        }
    }

    throw new Error('Unable to load Supabase library from available CDNs.');
}

// Wait for Supabase CDN library to be available (handles race conditions)
function waitForSupabase(maxWaitMs = 15000) {
    return new Promise((resolve, reject) => {
        // If already loaded, resolve immediately
        if (window.supabase && typeof window.supabase.createClient === 'function') {
            resolve(window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY));
            return;
        }
        const interval = 50;
        let waited = 0;
        const timer = setInterval(() => {
            if (window.supabase && typeof window.supabase.createClient === 'function') {
                clearInterval(timer);
                resolve(window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY));
            } else {
                waited += interval;
                if (waited >= maxWaitMs) {
                    clearInterval(timer);
                    reject(new Error('Supabase library failed to load. Please check your internet connection and refresh.'));
                }
            }
        }, interval);
    });
}

class AuthHelper {
    constructor(supabaseClient) {
        this.supabase = supabaseClient;
        this.isProcessingLogin = false;
        this.isInitialized = true;
    }

    isNetworkFetchError(error) {
        if (!error) return false;
        const message = String(error.message || '').toLowerCase();
        return message.includes('failed to fetch') || message.includes('networkerror') || message.includes('network request failed');
    }

    async runWithRetry(operationName, operation, retries = 2, delayMs = 1200) {
        let lastError = null;
        for (let attempt = 0; attempt <= retries; attempt++) {
            try {
                return await operation();
            } catch (error) {
                lastError = error;
                const isRetryable = this.isNetworkFetchError(error);
                if (!isRetryable || attempt === retries) {
                    throw error;
                }
                console.warn(`⚠️ ${operationName} network issue (attempt ${attempt + 1}/${retries + 1}), retrying...`);
                await new Promise((resolve) => setTimeout(resolve, delayMs * (attempt + 1)));
            }
        }
        throw lastError;
    }

    getFriendlyErrorMessage(error, fallback = 'Something went wrong. Please try again.') {
        if (this.isNetworkFetchError(error)) {
            return 'Network connection issue while contacting server. Please check internet and try again.';
        }
        return error?.message || fallback;
    }

    async checkEmailExists(email) {
        try {
            console.log('🔍 Checking if email exists:', email);
            
            // Check donor_profiles
            const { data: donorData, error: donorError } = await this.supabase
                .from('donor_profiles')
                .select('email')
                .eq('email', email)
                .maybeSingle();

            if (donorError) {
                console.error('❌ Error checking donor profiles:', donorError);
            }

            if (donorData) {
                console.log('❌ Email exists in donor profiles:', email);
                return true;
            }

            // Check ngo_profiles
            const { data: ngoData, error: ngoError } = await this.supabase
                .from('ngo_profiles')
                .select('contact_email')
                .eq('contact_email', email)
                .maybeSingle();

            if (ngoError) {
                console.error('❌ Error checking NGO profiles:', ngoError);
            }

            if (ngoData) {
                console.log('❌ Email exists in NGO profiles:', email);
                return true;
            }

            console.log('✅ Email is available:', email);
            return false;

        } catch (error) {
            console.error('💥 Error checking email existence:', error);
            return false;
        }
    }

    // Check if email belongs to a deleted account
    async isEmailFromDeletedAccount(email) {
        try {
            console.log('🔍 Checking if email was from deleted account:', email);
            
            const { error } = await this.supabase.auth.signInWithPassword({
                email: email,
                password: 'dummy_password'
            });

            if (error && error.message.includes('Invalid login credentials')) {
                console.log('✅ Email exists in auth but can be reused for deleted accounts');
                return true;
            }

            return false;

        } catch (error) {
            console.log('🔍 Auth check result:', error.message);
            return false;
        }
    }

    async checkPhoneExists(phoneNumber, userType = 'donor') {
        try {
            console.log('🔍 Checking if phone number exists:', phoneNumber);
            
            if (!phoneNumber) {
                return false;
            }

            const cleanPhone = phoneNumber.replace(/\D/g, '');

            if (userType === 'donor' || userType === 'both') {
                const { data: donorData, error: donorError } = await this.supabase
                    .from('donor_profiles')
                    .select('phone_number')
                    .eq('phone_number', cleanPhone)
                    .maybeSingle();

                if (donorError) {
                    console.error('❌ Error checking donor phone numbers:', donorError);
                }

                if (donorData) {
                    console.log('❌ Phone number exists in donor profiles:', cleanPhone);
                    return true;
                }
            }

            if (userType === 'ngo' || userType === 'both') {
                const { data: ngoData, error: ngoError } = await this.supabase
                    .from('ngo_profiles')
                    .select('contact_phone')
                    .eq('contact_phone', cleanPhone)
                    .maybeSingle();

                if (ngoError) {
                    console.error('❌ Error checking NGO phone numbers:', ngoError);
                }

                if (ngoData) {
                    console.log('❌ Phone number exists in NGO profiles:', cleanPhone);
                    return true;
                }
            }

            console.log('✅ Phone number is available:', cleanPhone);
            return false;

        } catch (error) {
            console.error('💥 Error checking phone number:', error);
            return false;
        }
    }

    async loginUser(email, password) {
        try {
            if (this.isProcessingLogin) {
                console.log('⏳ Login already in progress, skipping...');
                return;
            }

            this.isProcessingLogin = true;
            console.log('🔐 Attempting login for:', email);
            
            const { data, error } = await this.runWithRetry('Login request', () =>
                this.supabase.auth.signInWithPassword({
                    email: email,
                    password: password
                })
            );
            
            if (error) {
                console.error('❌ Login error:', error);
                this.isProcessingLogin = false;
                throw error;
            }

            console.log('✅ Login successful, user ID:', data.user.id);

            // Check NGO profile FIRST
            const { data: ngoProfile, error: ngoError } = await this.supabase
                .from('ngo_profiles')
                .select('id, status, ngo_name')
                .eq('id', data.user.id)
                .maybeSingle();

            console.log('🏢 NGO profile check:', { ngoProfile, ngoError });

            // If user is an NGO, handle NGO flow FIRST
            if (ngoProfile) {
                console.log('🏢 User is an NGO with status:', ngoProfile.status);
                
                if (ngoProfile.status === 'pending') {
                    console.log('⏳ NGO account pending approval');
                    this.isProcessingLogin = false;
                    window.location.href = 'ngo-pending.html';
                    return;
                } else if (ngoProfile.status === 'rejected') {
                    console.log('❌ NGO account rejected');
                    this.isProcessingLogin = false;
                    window.location.href = 'ngo-rejected.html';
                    return;
                } else if (ngoProfile.status === 'approved') {
                    console.log('✅ NGO account approved, redirecting to dashboard');
                    this.isProcessingLogin = false;
                    window.location.href = 'ngodashboard.html';
                    return;
                }
            }

            // THEN check if admin (only if not an NGO)
            const { data: donorProfile } = await this.supabase
                .from('donor_profiles')
                .select('role')
                .eq('id', data.user.id)
                .maybeSingle();

            if (donorProfile && donorProfile.role === 'admin') {
                console.log('👑 Admin user detected, redirecting to admin panel');
                this.isProcessingLogin = false;
                window.location.href = 'admin-panel.html';
                return;
            }

            // If not an admin or NGO, check for a donor profile.
            if (donorProfile) {
                console.log('🎯 User is a donor, redirecting to donor dashboard');
                this.isProcessingLogin = false;
                window.location.href = 'dashboard.html';
                return;
            }

            // Default fallback - redirect to role selection
            console.log('❓ No profile found and no context, redirecting to role selection');
            this.isProcessingLogin = false;
            window.location.href = 'donororngo.html';

        } catch (error) {
            console.error('💥 Login failed:', error);
            this.isProcessingLogin = false;
            
            // Handle case where no profile exists
            if (error.code === 'PGRST116') {
                console.log('❓ User has no profile, redirecting to role selection');
                window.location.href = 'donororngo.html';
                return;
            }
            
            throw error;
        }
    }

    async signupDonor(userData) {
        try {
            console.log('👤 Starting donor registration...', userData.email);

            // Check if email exists in active accounts
            const emailExists = await this.checkEmailExists(userData.email);
            if (emailExists) {
                throw new Error('This email address is already registered. Please use a different email or try logging in.');
            }

            // Check if phone number already exists (if provided)
            if (userData.phoneNumber && userData.phoneNumber.trim() !== '') {
                const phoneExists = await this.checkPhoneExists(userData.phoneNumber, 'donor');
                if (phoneExists) {
                    throw new Error('This phone number is already registered. Please use a different phone number.');
                }
            }

            // Create auth user
            const { data: authData, error: authError } = await this.runWithRetry('Donor auth signup', () =>
                this.supabase.auth.signUp({
                    email: userData.email,
                    password: userData.password
                })
            );
            
            if (authError) {
                if (authError.message.includes('already registered')) {
                    throw new Error('This email address is already registered. Please use a different email or try logging in.');
                }
                throw authError;
            }
            
            if (!authData.user) throw new Error('User creation failed');

            console.log('✅ Auth user created:', authData.user.id);

            // Create donor profile
            const { error: profileError } = await this.runWithRetry('Donor profile creation', () =>
                this.supabase.from('donor_profiles').insert([{
                    id: authData.user.id,
                    first_name: userData.firstName,
                    last_name: userData.lastName,
                    email: userData.email,
                    phone_number: userData.phoneNumber ? userData.phoneNumber.replace(/\D/g, '') : null,
                    age: userData.age,
                    city: userData.city,
                    state: userData.state,
                    pin_code: userData.pinCode,
                    address: userData.address
                }])
            );

            if (profileError) throw profileError;

            console.log('✅ Donor profile created');

            // Auto sign in after successful registration
            const { error: signInError } = await this.runWithRetry('Donor auto-login', () =>
                this.supabase.auth.signInWithPassword({
                    email: userData.email,
                    password: userData.password
                })
            );

            if (signInError) {
                console.warn('⚠️ Auto sign-in failed, but registration was successful. Redirecting to login.');
                window.location.href = 'loginsignup.html?message=Registration successful! Please sign in.';
                return;
            }

            console.log('🎉 Donor registration and auto-login complete, redirecting to dashboard...');
            window.location.href = 'dashboard.html';

        } catch (error) {
            console.error('💥 Donor registration failed:', error);
            throw new Error(this.getFriendlyErrorMessage(error, 'Donor registration failed. Please try again.'));
        }
    }

    async signupNGO(ngoData, files = null) {
        try {
            console.log('🏢 Starting NGO registration...', ngoData.email);

            // Enhanced email checking logic
            const emailExistsInProfiles = await this.checkEmailExists(ngoData.email);
            const isFromDeletedAccount = await this.isEmailFromDeletedAccount(ngoData.email);

            if (emailExistsInProfiles && !isFromDeletedAccount) {
                throw new Error('This email address is already registered in an active account. Please use a different email or try logging in.');
            }

            if (isFromDeletedAccount) {
                console.log('🔄 Email was from deleted account, allowing re-registration');
            }

            // Check if phone number already exists
            const phoneExists = await this.checkPhoneExists(ngoData.contactNumber, 'ngo');
            if (phoneExists) {
                throw new Error('This phone number is already registered. Please use a different phone number.');
            }

            // Verify Darpan ID if provided
            if (ngoData.darpanId) {
                const isDarpanApproved = await this.verifyDarpanId(ngoData.darpanId);
                if (!isDarpanApproved) {
                    console.warn('⚠️ Darpan ID not pre-approved. Continuing with pending review:', ngoData.darpanId);
                }
            }

            // Handle auth user creation for deleted accounts
            let authData;
            try {
                const result = await this.runWithRetry('NGO auth signup', () =>
                    this.supabase.auth.signUp({
                        email: ngoData.email,
                        password: ngoData.password
                    })
                );
                
                authData = result.data;
                const authError = result.error;

                if (authError) {
                    if (authError.message.includes('already registered')) {
                        if (isFromDeletedAccount) {
                            console.log('🔄 Attempting to reuse email from deleted account');
                            const signInResult = await this.runWithRetry('NGO auth sign-in for existing account', () =>
                                this.supabase.auth.signInWithPassword({
                                    email: ngoData.email,
                                    password: ngoData.password
                                })
                            );

                            if (signInResult.error) {
                                throw new Error('This email is already registered. If this is your previous account, please use your original password or contact support.');
                            }
                            
                            authData = signInResult.data;
                        } else {
                            throw new Error('This email address is already registered. Please use a different email or try logging in.');
                        }
                    } else {
                        throw authError;
                    }
                }
            } catch (authError) {
                console.error('Auth error:', authError);
                throw authError;
            }

            if (!authData || !authData.user) {
                throw new Error('User authentication failed');
            }

            console.log('✅ Auth user handled:', authData.user.id);

            // Upload documents if provided
            let documentUrls = {};
            if (files) {
                documentUrls = await this.uploadNgoDocuments(authData.user.id, files);
            }

            // Create NGO profile with pending status
            const { error: profileError } = await this.runWithRetry('NGO profile creation', () =>
                this.supabase.from('ngo_profiles').insert([{
                    id: authData.user.id,
                    ngo_name: ngoData.ngoName,
                    org_type: ngoData.orgType,
                    registration_number: ngoData.regNumber,
                    registration_date: ngoData.regDate,
                    address: ngoData.address,
                    city: ngoData.city,
                    state: ngoData.state,
                    pin_code: ngoData.pincode,
                    contact_phone: ngoData.contactNumber ? ngoData.contactNumber.replace(/\D/g, '') : null,
                    contact_email: ngoData.email,
                    website_url: ngoData.website,
                    darpan_id: ngoData.darpanId,
                    status: 'pending'
                }])
            );

            if (profileError) {
                console.error('❌ NGO profile creation error:', profileError);
                
                if (isFromDeletedAccount && profileError.code === '23505') {
                    throw new Error('This email is already registered. Please contact support.');
                }
                
                throw profileError;
            }

            console.log('✅ NGO profile created with pending status');

            // Store document references
            if (Object.keys(documentUrls).length > 0) {
                await this.storeDocumentReferences(authData.user.id, documentUrls);
            }

            // Auto sign in after successful registration
            const { error: signInError } = await this.runWithRetry('NGO auto-login', () =>
                this.supabase.auth.signInWithPassword({
                    email: ngoData.email,
                    password: ngoData.password
                })
            );

            if (signInError) {
                console.warn('⚠️ Auto sign-in failed, but registration was successful. Redirecting to login.');
                window.location.href = 'loginsignup.html?message=Registration successful! Please sign in to check your status.';
                return;
            }

            console.log('🎉 NGO registration and auto-login complete, redirecting to pending page...');
            window.location.href = 'ngo-pending.html';

        } catch (error) {
            console.error('💥 NGO registration failed:', error);
            throw new Error(this.getFriendlyErrorMessage(error, 'NGO registration failed. Please try again.'));
        }
    }

    async verifyDarpanId(darpanId) {
        try {
            const { data, error } = await this.supabase
                .from('approved_darpan_ids')
                .select('id')
                .eq('darpan_id', darpanId)
                .eq('is_active', true)
                .maybeSingle();

            if (error) {
                console.error('Error verifying Darpan ID:', error);
                // Do not block registration when verification service is temporarily unavailable.
                return true;
            }

            return !!data;
        } catch (error) {
            console.error('Error in Darpan verification:', error);
            return false;
        }
    }

    async uploadNgoDocuments(userId, files) {
        const documentUrls = {};
        
        try {
            for (const [docType, file] of Object.entries(files)) {
                if (file) {
                    const fileExt = file.name.split('.').pop();
                    const fileName = `${userId}_${docType}_${Date.now()}.${fileExt}`;
                    const filePath = `ngo-documents/${userId}/${fileName}`;

                    const { error: uploadError } = await this.supabase.storage
                        .from('verification-docs')
                        .upload(filePath, file);

                    if (uploadError) {
                        console.error(`Error uploading ${docType}:`, uploadError);
                        continue;
                    }

                    const { data } = this.supabase.storage
                        .from('verification-docs')
                        .getPublicUrl(filePath);

                    documentUrls[docType] = {
                        file_name: fileName,
                        file_path: filePath,
                        public_url: data.publicUrl
                    };
                }
            }
        } catch (error) {
            console.error('Error uploading documents:', error);
        }

        return documentUrls;
    }

    async storeDocumentReferences(userId, documentUrls) {
        try {
            const documentRecords = Object.entries(documentUrls).map(([docType, docInfo]) => ({
                ngo_id: userId,
                document_type: docType,
                file_name: docInfo.file_name,
                file_path: docInfo.file_path
            }));

            const { error } = await this.supabase
                .from('ngo_verification_docs')
                .insert(documentRecords);

            if (error) {
                console.error('Error storing document references:', error);
            }
        } catch (error) {
            console.error('Error in storeDocumentReferences:', error);
        }
    }

    async deleteUserAccount() {
        try {
            const user = await this.getCurrentUser();
            if (!user) {
                throw new Error('No user logged in');
            }

            console.log('🗑️ Starting account deletion for user:', user.id);

            // First, check if user is donor or NGO to handle related data
            const { data: donorProfile } = await this.supabase
                .from('donor_profiles')
                .select('id')
                .eq('id', user.id)
                .maybeSingle();

            const { data: ngoProfile } = await this.supabase
                .from('ngo_profiles')
                .select('id, status')
                .eq('id', user.id)
                .maybeSingle();

            // Delete all user data from our tables
            // Delete from ngo_verification_docs first (if NGO)
            if (ngoProfile) {
                const { error: docsError } = await this.supabase
                    .from('ngo_verification_docs')
                    .delete()
                    .eq('ngo_id', user.id);
                
                if (docsError) {
                    console.error('Error deleting verification docs:', docsError);
                }

                // Delete NGO profile
                const { error: ngoError } = await this.supabase
                    .from('ngo_profiles')
                    .delete()
                    .eq('id', user.id);
                
                if (ngoError) {
                    console.error('Error deleting NGO profile:', ngoError);
                }
            }

            // Delete donor profile (if exists)
            if (donorProfile) {
                const { error: donorError } = await this.supabase
                    .from('donor_profiles')
                    .delete()
                    .eq('id', user.id);
                
                if (donorError) {
                    console.error('Error deleting donor profile:', donorError);
                }
            }

            // Delete from other user-related tables
            const { error: feedbackError } = await this.supabase
                .from('feedback')
                .delete()
                .eq('user_id', user.id);
            
            if (feedbackError) {
                console.error('Error deleting feedback:', feedbackError);
            }

            // Delete from redeemed_rewards
            const { error: rewardsError } = await this.supabase
                .from('redeemed_rewards')
                .delete()
                .eq('user_id', user.id);
            
            if (rewardsError) {
                console.error('Error deleting rewards:', rewardsError);
            }

            console.log('✅ User data deleted successfully from all tables');

            // Note: Auth user remains but all profile data is gone
            // User can now re-register with the same email

            // Redirect to home page
            window.location.href = 'index.html?message=Account deleted successfully. You can re-register with the same email.';

        } catch (error) {
            console.error('💥 Account deletion failed:', error);
            throw error;
        }
    }

    async deleteUserAccountWithConfirmation() {
        const confirmation = confirm(
            'Are you sure you want to delete your account? This will remove all your data but you can re-register with the same email later. ' +
            'All your donations, requests, and profile information will be permanently deleted.'
        );

        if (!confirmation) {
            return;
        }

        const secondConfirmation = confirm(
            'FINAL WARNING: This will permanently delete your account data. ' +
            'You will be able to re-register with the same email. Click OK to confirm deletion.'
        );

        if (!secondConfirmation) {
            return;
        }

        try {
            await this.deleteUserAccount();
        } catch (error) {
            alert('Account deletion failed: ' + error.message);
        }
    }

    async checkAuth() {
        const { data: { session } } = await this.supabase.auth.getSession();
        return session;
    }

    async getCurrentUser() {
        const { data: { user } } = await this.supabase.auth.getUser();
        return user;
    }

    async logoutUser() {
        try {
            console.log('🚪 Starting logout process...');
            
            // Clear login state
            this.isProcessingLogin = false;
            
            // ONLY sign out from Supabase - DO NOT clear storage
            await this.supabase.auth.signOut();
            
            console.log('✅ Logout completed');
            
            // Redirect to login
            window.location.href = 'loginsignup.html';
            
        } catch (error) {
            console.error('💥 Logout failed:', error);
            window.location.href = 'loginsignup.html';
        }
    }

    // Helper method to check if user is approved NGO
    async isApprovedNGO() {
        try {
            const user = await this.getCurrentUser();
            if (!user) return false;

            const { data: ngoProfile } = await this.supabase
                .from('ngo_profiles')
                .select('status')
                .eq('id', user.id)
                .maybeSingle();

            return ngoProfile && ngoProfile.status === 'approved';
        } catch (error) {
            console.error('Error checking NGO status:', error);
            return false;
        }
    }

    // Helper method to check if user is donor
    async isDonor() {
        try {
            const user = await this.getCurrentUser();
            if (!user) return false;

            const { data: donorProfile } = await this.supabase
                .from('donor_profiles')
                .select('id')
                .eq('id', user.id)
                .maybeSingle();

            return !!donorProfile;
        } catch (error) {
            console.error('Error checking donor status:', error);
            return false;
        }
    }
}

// ============================================================
// INITIALIZATION - handles CDN race condition robustly
// ============================================================

// Create the authReady promise that all pages will await
window.authReady = (async () => {
    try {
        await ensureSupabaseLibraryLoaded();
        // Wait for Supabase CDN (up to 15 seconds)
        const client = await waitForSupabase(15000);
        console.log('✅ Supabase client created');

        // Create and expose the AuthHelper instance
        window.authHelper = new AuthHelper(client);
        console.log('✅ AuthHelper fully initialized and attached to window');
    } catch (err) {
        console.error('❌ Failed to initialize AuthHelper:', err.message);
        // Set a minimal object so pages can detect the failure
        window.authHelper = { _initError: err.message, isInitialized: false };
        throw err;
    }
})();
