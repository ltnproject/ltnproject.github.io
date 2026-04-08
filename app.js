const SUPABASE_URL = 'https://yfzyuyedyksmqjmrjrvg.supabase.co';
const SUPABASE_KEY = 'sb_publishable_L-HtaTj5NsX4qTkEDIc5Pw_W7FQr6WK';

const { createClient } = supabase;
const client = createClient(SUPABASE_URL, SUPABASE_KEY);

// Replace icons
lucide.createIcons();

// Helper to check session
async function checkUser() {
    const { data: { session } } = await client.auth.getSession();
    return session ? session.user : null;
}

// Redirect if not logged in
async function requireAuth() {
    const user = await checkUser();
    if (!user) {
        window.location.href = 'home.html';
    }
    return user;
}

// Global Sign Out
async function signOut() {
    await client.auth.signOut();
    window.location.href = 'home.html';
}

window.D4rkzB = { client, checkUser, requireAuth, signOut };
