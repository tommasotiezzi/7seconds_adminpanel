// Supabase configuration
const SUPABASE_URL = 'https://bvdqbzdiwcrlqmqdcvmv.supabase.co';
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImJ2ZHFiemRpd2NybHFtcWRjdm12Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NTU2ODc3MTcsImV4cCI6MjA3MTI2MzcxN30.aN-6AoFZWr07lmPcIdh-vc-DgFNNL3luXQJw4C18T_g';
const supabase = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

// Google Places API configuration
const GOOGLE_API_KEY = 'AIzaSyDF7OvTsuLGaYk-YGp5eci6CiI6iRqasSk';
const PLACES_API_BASE = 'https://places.googleapis.com/v1/places:searchText';
const PLACES_PHOTO_BASE = 'https://places.googleapis.com/v1';

// Global variables
let currentUser = null;
let currentOrganizer = null;
let selectedVenue = null;
let savedVenues = [];
let searchTimeout = null;
let editingEventId = null;
let statusUpdateTimeouts = new Map(); // Store timeouts for scheduled status updates

// ========================================
// AUTHENTICATION CHECK
// ========================================

document.addEventListener('DOMContentLoaded', async () => {
    const { data: { session } } = await supabase.auth.getSession();
    
    if (!session) {
        window.location.href = 'login.html';
        return;
    }
    
    currentUser = session.user;
    console.log('Logged in as:', currentUser.email);
    
    await initializeApp();
    setupEventListeners();
});

supabase.auth.onAuthStateChange((event, session) => {
    if (event === 'SIGNED_OUT') {
        window.location.href = 'login.html';
    }
});

// ========================================
// INITIALIZATION
// ========================================

async function initializeApp() {
    try {
        await getOrganizerProfile();
        await loadSavedVenues();
        initializeVenueInput();
        setDefaultDateTimes();
        
        if (currentUser) {
            document.getElementById('user-email').textContent = currentUser.email;
            if (currentOrganizer) {
                updateTierBadge();
                checkProfileCompletion();
                checkSubscriptionStatus();
            }
        }
        
        // Initial status update and schedule future updates
        await updateEventStatuses();
        await scheduleStatusUpdates();
        
        // Fallback check every 10 minutes (instead of every minute)
        setInterval(async () => {
            await updateEventStatuses();
            await scheduleStatusUpdates();
        }, 600000); // 10 minutes
        
    } catch (error) {
        console.error('Error initializing app:', error);
        showError('Failed to initialize app. Please refresh the page.');
    }
}

// ========================================
// SUBSCRIPTION STATUS MANAGEMENT (NEW)
// ========================================

function updateTierBadge() {
    const tierBadge = document.getElementById('user-tier');
    const tier = currentOrganizer.subscription_tier || 'free';
    
    tierBadge.textContent = tier;
    tierBadge.className = `tier-badge ${tier}`;
}

function checkProfileCompletion() {
    if (!currentOrganizer.contact_name || !currentOrganizer.phone) {
        const alertContainer = document.getElementById('profile-alert-container');
        if (alertContainer) {
            alertContainer.innerHTML = `
                <div class="profile-incomplete-alert">
                    <div class="alert-content">
                        <span>⚠️ Please complete your profile to unlock all features</span>
                        <button onclick="switchTab('user-details')" class="btn-complete-profile">Complete Profile</button>
                    </div>
                </div>
            `;
        }
    }
}

function checkSubscriptionStatus() {
    const tier = currentOrganizer.subscription_tier || 'free';
    const createEventBtn = document.getElementById('submit-btn');
    const eventFormContainer = document.getElementById('events-tab');
    const statusMessageDiv = document.getElementById('events-status-message');
    
    // Clear existing status messages
    if (statusMessageDiv) {
        statusMessageDiv.innerHTML = '';
    }
    
    switch(tier) {
        case 'free':
            disableEventCreation('Upgrade to Create Events');
            addStatusMessage(statusMessageDiv, 
                'You have a free account. Upgrade to start creating events.',
                'upgrade');
            break;
            
        case 'trial':
            const eventsUsed = currentOrganizer.events_used_this_period || 0;
            if (eventsUsed >= 1) {
                disableEventCreation('Trial Event Used - Upgrade for More');
                addStatusMessage(statusMessageDiv,
                    'You\'ve used your trial event. Upgrade to Basic for 4 events/month.',
                    'upgrade');
            } else {
                addStatusMessage(statusMessageDiv,
                    'Trial Account: 1 event remaining',
                    'info');
            }
            break;
            
        case 'basic':
            const eventsThisMonth = currentOrganizer.events_used_this_period || 0;
            const remaining = 4 - eventsThisMonth;
            
            if (remaining <= 0) {
                disableEventCreation('Monthly Limit Reached - Upgrade');
                addStatusMessage(statusMessageDiv,
                    'You\'ve used all 4 events this month. Upgrade to Premium for unlimited.',
                    'upgrade');
            } else {
                addStatusMessage(statusMessageDiv,
                    `Basic Account: ${remaining} event${remaining > 1 ? 's' : ''} remaining this month`,
                    'info');
            }
            break;
            
        case 'premium':
            addStatusMessage(statusMessageDiv,
                'Premium Account: Unlimited events and venues',
                'success');
            break;
    }
    
    // Check subscription expiry for paid tiers
    if (['basic', 'premium'].includes(tier) && currentOrganizer.current_period_end) {
        const endDate = new Date(currentOrganizer.current_period_end);
        const today = new Date();
        const daysRemaining = Math.ceil((endDate - today) / (1000 * 60 * 60 * 24));
        
        if (daysRemaining <= 0) {
            disableEventCreation('Subscription Expired - Renew');
            addStatusMessage(statusMessageDiv,
                'Your subscription has expired. Please renew to continue creating events.',
                'error');
        } else if (daysRemaining <= 7) {
            addStatusMessage(statusMessageDiv,
                `⚠️ Subscription expires in ${daysRemaining} days. Please renew soon.`,
                'warning');
        }
    }
}

function disableEventCreation(buttonText) {
    const createEventBtn = document.getElementById('submit-btn');
    if (createEventBtn) {
        createEventBtn.disabled = true;
        createEventBtn.textContent = buttonText;
        createEventBtn.style.cursor = 'not-allowed';
        createEventBtn.style.opacity = '0.6';
    }
}

function addStatusMessage(container, message, type) {
    if (!container) return;
    
    const messageDiv = document.createElement('div');
    messageDiv.className = `tier-status-message ${type}`;
    
    if (type === 'upgrade') {
        messageDiv.innerHTML = `
            <span>${message}</span>
            <button onclick="handleUpgrade()" class="btn-upgrade-inline">Upgrade Now</button>
        `;
    } else {
        messageDiv.textContent = message;
    }
    
    container.appendChild(messageDiv);
}

// Update profile function for User Details tab
async function updateProfile() {
    const contactName = document.getElementById('update-contact-name').value;
    const phone = document.getElementById('update-phone').value;
    
    if (!contactName || !phone) {
        showError('Please fill in all fields', 'user-details-tab');
        return;
    }
    
    try {
        const { error } = await supabase
            .from('organizers')
            .update({
                contact_name: contactName,
                phone: phone,
                updated_at: new Date().toISOString()
            })
            .eq('id', currentUser.id);
        
        if (error) throw error;
        
        currentOrganizer.contact_name = contactName;
        currentOrganizer.phone = phone;
        
        showSuccess('Profile updated successfully!', 'user-details-tab');
        
        // Hide profile completion form
        document.getElementById('profile-completion-form').style.display = 'none';
        
        // Remove profile alert if exists
        const alertContainer = document.getElementById('profile-alert-container');
        if (alertContainer) {
            alertContainer.innerHTML = '';
        }
        
        // Reload account info
        loadAccountInfo();
        
    } catch (error) {
        console.error('Error updating profile:', error);
        showError('Failed to update profile', 'user-details-tab');
    }
}

// Update event statuses based on current time
async function updateEventStatuses() {
    try {
        const nowUTC = new Date().toISOString();
        
        // Get all events for this organizer
        const { data: events, error: fetchError } = await supabase
            .from('events')
            .select('id, start_time, end_time, status')
            .eq('organizer_id', currentUser.id)
            .neq('status', 'cancelled'); // Don't update cancelled events
        
        if (fetchError) throw fetchError;
        
        if (!events || events.length === 0) return;
        
        for (const event of events) {
            const startTime = new Date(event.start_time);
            const endTime = new Date(event.end_time);
            const now = new Date();
            
            let newStatus = event.status;
            
            // Determine what the status should be
            if (now < startTime) {
                newStatus = 'scheduled';
            } else if (now >= startTime && now <= endTime) {
                newStatus = 'active';
            } else if (now > endTime) {
                newStatus = 'completed';
            }
            
            // Update if status has changed
            if (newStatus !== event.status) {
                const { error: updateError } = await supabase
                    .from('events')
                    .update({ status: newStatus })
                    .eq('id', event.id);
                
                if (updateError) {
                    console.error(`Error updating event ${event.id} status:`, updateError);
                } else {
                    console.log(`Updated event ${event.id} status from ${event.status} to ${newStatus}`);
                }
            }
        }
        
        // Refresh the current tab after updating statuses
        await refreshCurrentView();
        
    } catch (error) {
        console.error('Error updating event statuses:', error);
    }
}

// Schedule smart status updates based on event start/end times
async function scheduleStatusUpdates() {
    try {
        // Clear existing timeouts
        statusUpdateTimeouts.forEach(timeout => clearTimeout(timeout));
        statusUpdateTimeouts.clear();
        
        // Get all non-cancelled events for this organizer
        const { data: events, error } = await supabase
            .from('events')
            .select('id, start_time, end_time, status')
            .eq('organizer_id', currentUser.id)
            .neq('status', 'cancelled');
        
        if (error) throw error;
        if (!events || events.length === 0) return;
        
        const now = new Date();
        
        events.forEach(event => {
            const startTime = new Date(event.start_time);
            const endTime = new Date(event.end_time);
            
            // Schedule update for start time
            if (startTime > now) {
                const msUntilStart = startTime - now;
                if (msUntilStart < 2147483647) { // Max timeout value (about 24 days)
                    const startTimeout = setTimeout(async () => {
                        await updateSingleEventStatus(event.id, 'active');
                        await refreshCurrentView();
                    }, msUntilStart);
                    statusUpdateTimeouts.set(`${event.id}-start`, startTimeout);
                }
            }
            
            // Schedule update for end time
            if (endTime > now) {
                const msUntilEnd = endTime - now;
                if (msUntilEnd < 2147483647) { // Max timeout value
                    const endTimeout = setTimeout(async () => {
                        await updateSingleEventStatus(event.id, 'completed');
                        await refreshCurrentView();
                    }, msUntilEnd);
                    statusUpdateTimeouts.set(`${event.id}-end`, endTimeout);
                }
            }
        });
        
        console.log(`Scheduled ${statusUpdateTimeouts.size} status updates`);
    } catch (error) {
        console.error('Error scheduling status updates:', error);
    }
}

// Update a single event's status
async function updateSingleEventStatus(eventId, newStatus) {
    try {
        const { error } = await supabase
            .from('events')
            .update({ status: newStatus })
            .eq('id', eventId);
        
        if (error) {
            console.error(`Error updating event ${eventId} status:`, error);
        } else {
            console.log(`Updated event ${eventId} status to ${newStatus}`);
        }
    } catch (error) {
        console.error('Error in updateSingleEventStatus:', error);
    }
}

// Refresh the current view
async function refreshCurrentView() {
    const activeTab = document.querySelector('.nav-tab.active');
    if (activeTab) {
        const tabText = activeTab.textContent.trim();
        if (tabText === 'Live Events') {
            await loadLiveEvents();
        } else if (tabText === 'Upcoming') {
            await loadUpcomingEvents();
        } else if (tabText === 'Past Events') {
            await loadEventHistory();
        }
    }
}

// Setup event listeners
function setupEventListeners() {
    const editEventForm = document.getElementById('edit-event-form');
    if (editEventForm) {
        editEventForm.addEventListener('submit', async (e) => {
            e.preventDefault();
            
            const submitButton = e.target.querySelector('button[type="submit"]');
            const eventId = document.getElementById('edit-event-id').value;
            
            submitButton.disabled = true;
            submitButton.textContent = 'Updating...';
            
            try {
                const eventData = {
                    name: document.getElementById('edit-event-name').value,
                    venue_name: document.getElementById('edit-venue-name').value,
                    start_time: document.getElementById('edit-start-time').value,
                    end_time: document.getElementById('edit-end-time').value,
                    deck_size: parseInt(document.getElementById('edit-deck-size').value),
                    max_matches_allowed: parseInt(document.getElementById('edit-max-matches').value),
                    event_type: document.getElementById('edit-event-type').value
                };
                
                const { error } = await supabase
                    .from('events')
                    .update(eventData)
                    .eq('id', eventId)
                    .eq('organizer_id', currentUser.id);
                
                if (error) throw error;
                
                showSuccess('Event updated successfully!');
                closeEditModal();
                await loadUpcomingEvents();
                
            } catch (error) {
                console.error('Error updating event:', error);
                showError('Failed to update event: ' + error.message);
            } finally {
                submitButton.disabled = false;
                submitButton.textContent = 'Update Event';
            }
        });
    }
    
    const eventForm = document.getElementById('event-form');
    if (eventForm) {
        eventForm.addEventListener('submit', async (e) => {
            e.preventDefault();
            
            const submitButton = document.getElementById('submit-btn');
            
            if (!selectedVenue) {
                showError('Please select or add a venue first');
                return;
            }
            
            const originalButtonText = submitButton.textContent;
            submitButton.disabled = true;
            submitButton.textContent = editingEventId ? 'Updating...' : 'Creating...';
            
            try {
                if (!editingEventId && selectedVenue.isNew) {
                    const savedVenue = await saveVenue({
                        name: selectedVenue.venue_name,
                        address: selectedVenue.venue_address,
                        place_id: selectedVenue.place_id,
                        lat: selectedVenue.lat,
                        lng: selectedVenue.lng,
                        photo_url: selectedVenue.photo_url // Add photo URL to saved venue
                    });
                    
                    if (savedVenue) {
                        selectedVenue = savedVenue;
                        showSuccess(`Venue "${selectedVenue.venue_name}" saved!`);
                    }
                }
                
                const eventData = {
                    name: document.getElementById('event-name').value,
                    venue_name: selectedVenue.venue_name,
                    venue_address: selectedVenue.venue_address,
                    place_id: selectedVenue.place_id,
                    lat: selectedVenue.lat,
                    lng: selectedVenue.lng,
                    venue_photo_url: selectedVenue.photo_url || selectedVenue.venue_photo_url, // Add photo URL to event
                    start_time: document.getElementById('start-time').value,
                    end_time: document.getElementById('end-time').value,
                    deck_size: parseInt(document.getElementById('deck-size').value),
                    max_matches_allowed: parseInt(document.getElementById('max-matches').value),
                    event_type: document.getElementById('event-type').value
                };
                
                let event;
                if (editingEventId) {
                    event = await updateEvent(editingEventId, eventData);
                    showSuccess('Event updated successfully!');
                    cancelEdit();
                } else {
                    event = await createEvent(eventData);
                    if (event) {
                        showSuccess('Event created successfully!');
                        document.getElementById('event-form').reset();
                        
                        const venueInput = document.getElementById('venue-input');
                        venueInput.value = selectedVenue.venue_name;
                        venueInput.classList.add('has-value');
                        
                        setDefaultDateTimes();
                        
                        // Re-schedule status updates for the new event
                        await scheduleStatusUpdates();
                        
                        // Refresh subscription status after creating event
                        await getOrganizerProfile(); // Refresh organizer data
                        checkSubscriptionStatus(); // Update UI
                    }
                }
                
                await loadUpcomingEvents();
                
            } catch (error) {
                console.error('Error submitting event:', error);
                showError('Failed to ' + (editingEventId ? 'update' : 'create') + ' event: ' + error.message);
            } finally {
                submitButton.disabled = false;
                submitButton.textContent = originalButtonText;
            }
        });
    }
}

async function logout() {
    await supabase.auth.signOut();
    window.location.href = 'login.html';
}

// ========================================
// ORGANIZER PROFILE
// ========================================

async function getOrganizerProfile() {
    try {
        const { data: regularUser, error: userCheckError } = await supabase
            .from('users')
            .select('id')
            .eq('id', currentUser.id)
            .maybeSingle();
        
        if (regularUser) {
            console.error('Access denied: This is a regular app user, not an organizer');
            showError('Access Denied: This account is for the mobile app, not the admin panel.');
            
            await supabase.auth.signOut();
            setTimeout(() => {
                window.location.href = 'login.html';
            }, 2000);
            return;
        }
        
        let { data: organizer, error } = await supabase
            .from('organizers')
            .select('*')
            .eq('id', currentUser.id)
            .single();
        
        if (error && error.code === 'PGRST116') {
            const { data: newOrganizer, error: insertError } = await supabase
                .from('organizers')
                .insert({
                    id: currentUser.id,
                    subscription_tier: 'free', // Changed from 'basic' to 'free' for new users
                    max_venues: 0
                })
                .select()
                .single();
            
            if (insertError) throw insertError;
            currentOrganizer = newOrganizer;
        } else if (error) {
            throw error;
        } else {
            currentOrganizer = organizer;
        }
        
        console.log('Organizer profile:', currentOrganizer);
    } catch (error) {
        console.error('Error getting organizer profile:', error);
        showError('Failed to load organizer profile');
    }
}

// ========================================
// USER DETAILS TAB
// ========================================

async function loadUserDetails() {
    // Load account information
    loadAccountInfo();
    
    // Load subscription details
    loadSubscriptionInfo();
    
    // Load usage statistics
    loadUsageStats();
    
    // Load saved venues list
    loadSavedVenuesList();
}

async function loadAccountInfo() {
    const accountInfoDiv = document.getElementById('account-info');
    
    if (!currentOrganizer) {
        accountInfoDiv.innerHTML = '<div class="loading">No account information available</div>';
        return;
    }
    
    const createdDate = new Date(currentOrganizer.created_at).toLocaleDateString();
    const lastUpdated = new Date(currentOrganizer.updated_at).toLocaleDateString();
    
    // Check if profile is incomplete and show form
    const needsCompletion = !currentOrganizer.contact_name || !currentOrganizer.phone;
    
    accountInfoDiv.innerHTML = `
        <div class="info-item">
            <span class="info-label">Account ID</span>
            <span class="info-value">${currentOrganizer.id.substring(0, 8)}...</span>
        </div>
        <div class="info-item">
            <span class="info-label">Email</span>
            <span class="info-value">${currentUser.email}</span>
        </div>
        <div class="info-item">
            <span class="info-label">Company Name</span>
            <span class="info-value">${currentOrganizer.company_name || 'Not set'}</span>
        </div>
        <div class="info-item">
            <span class="info-label">Contact Name</span>
            <span class="info-value">${currentOrganizer.contact_name || 'Not set'}</span>
        </div>
        <div class="info-item">
            <span class="info-label">Phone</span>
            <span class="info-value">${currentOrganizer.phone || 'Not set'}</span>
        </div>
        <div class="info-item">
            <span class="info-label">Account Created</span>
            <span class="info-value">${createdDate}</span>
        </div>
    `;
    
    // Show profile completion form if needed
    const completionForm = document.getElementById('profile-completion-form');
    if (completionForm && needsCompletion) {
        completionForm.style.display = 'block';
        
        // Pre-fill if we have values
        if (currentOrganizer.contact_name) {
            document.getElementById('update-contact-name').value = currentOrganizer.contact_name;
        }
        if (currentOrganizer.phone) {
            document.getElementById('update-phone').value = currentOrganizer.phone;
        }
    }
}

async function loadSubscriptionInfo() {
    const subscriptionInfoDiv = document.getElementById('subscription-info');
    
    if (!currentOrganizer) {
        subscriptionInfoDiv.innerHTML = '<div class="loading">No subscription information available</div>';
        return;
    }
    
    const tier = currentOrganizer.subscription_tier || 'free';
    const startDate = currentOrganizer.subscription_start_date 
        ? new Date(currentOrganizer.subscription_start_date).toLocaleDateString() 
        : 'N/A';
    const endDate = currentOrganizer.subscription_end_date 
        ? new Date(currentOrganizer.subscription_end_date).toLocaleDateString() 
        : 'N/A';
    
    const daysRemaining = currentOrganizer.subscription_end_date 
        ? Math.ceil((new Date(currentOrganizer.subscription_end_date) - new Date()) / (1000 * 60 * 60 * 24))
        : null;
    
    const isExpiringSoon = daysRemaining && daysRemaining <= 7;
    
    let tierSpecificInfo = '';
    
    switch(tier) {
        case 'free':
            tierSpecificInfo = `
                <div class="info-item">
                    <span class="info-label">Events Allowed</span>
                    <span class="info-value">0 (Upgrade to create events)</span>
                </div>
            `;
            break;
        case 'trial':
            tierSpecificInfo = `
                <div class="info-item">
                    <span class="info-label">Trial Events Remaining</span>
                    <span class="info-value">${1 - (currentOrganizer.events_used_this_period || 0)}</span>
                </div>
            `;
            break;
        case 'basic':
            tierSpecificInfo = `
                <div class="info-item">
                    <span class="info-label">Events This Month</span>
                    <span class="info-value">${currentOrganizer.events_used_this_period || 0} / 4</span>
                </div>
            `;
            break;
        case 'premium':
            tierSpecificInfo = `
                <div class="info-item">
                    <span class="info-label">Events Allowed</span>
                    <span class="info-value">Unlimited</span>
                </div>
            `;
            break;
    }
    
    subscriptionInfoDiv.innerHTML = `
        <div class="subscription-badge ${tier}">${tier}</div>
        
        <div class="subscription-details">
            <div class="info-item">
                <span class="info-label">Subscription Start</span>
                <span class="info-value">${startDate}</span>
            </div>
            <div class="info-item">
                <span class="info-label">Subscription End</span>
                <span class="info-value">${endDate}</span>
            </div>
            <div class="info-item">
                <span class="info-label">Max Venues Allowed</span>
                <span class="info-value">${currentOrganizer.max_venues || (tier === 'premium' ? 'Unlimited' : '1')}</span>
            </div>
            ${tierSpecificInfo}
            <div class="info-item">
                <span class="info-label">Status</span>
                <span class="info-value">${daysRemaining && daysRemaining > 0 ? `Active (${daysRemaining} days remaining)` : 'Active'}</span>
            </div>
        </div>
        
        ${isExpiringSoon ? `
            <div class="warning-text">
                ⚠️ Your subscription expires in ${daysRemaining} days. Please renew to continue using the service.
            </div>
        ` : ''}
        
        ${tier !== 'premium' ? `
            <div class="upgrade-prompt">
                <h4>Upgrade to ${tier === 'free' ? 'Trial' : 'Premium'}</h4>
                <p>${tier === 'free' ? 'Try one event for €29' : 'Unlock unlimited events and venues'}</p>
                <button class="btn-upgrade" onclick="handleUpgrade()">Upgrade Now</button>
            </div>
        ` : ''}
    `;
}

async function loadUsageStats() {
    const usageStatsDiv = document.getElementById('usage-stats');
    
    try {
        // Get total events count
        const { data: allEvents, error: eventsError } = await supabase
            .from('events')
            .select('id, status')
            .eq('organizer_id', currentUser.id);
        
        if (eventsError) throw eventsError;
        
        const totalEvents = allEvents ? allEvents.length : 0;
        const activeEvents = allEvents ? allEvents.filter(e => e.status === 'active').length : 0;
        const completedEvents = allEvents ? allEvents.filter(e => e.status === 'completed').length : 0;
        
        // Get total matches from completed events
        const { data: matchStats, error: matchError } = await supabase
            .from('event_stats')
            .select('total_matches_completed')
            .in('event_id', allEvents ? allEvents.map(e => e.id) : []);
        
        const totalMatches = matchStats 
            ? matchStats.reduce((sum, stat) => sum + (stat.total_matches_completed || 0), 0)
            : 0;
        
        // Get venues count
        const venuesCount = savedVenues.length;
        
        usageStatsDiv.innerHTML = `
            <div class="stat-card">
                <div class="stat-value">${totalEvents}</div>
                <div class="stat-label">Total Events</div>
            </div>
            <div class="stat-card">
                <div class="stat-value">${activeEvents}</div>
                <div class="stat-label">Active Events</div>
            </div>
            <div class="stat-card">
                <div class="stat-value">${completedEvents}</div>
                <div class="stat-label">Completed</div>
            </div>
            <div class="stat-card">
                <div class="stat-value">${totalMatches}</div>
                <div class="stat-label">Total Matches</div>
            </div>
            <div class="stat-card">
                <div class="stat-value">${venuesCount}</div>
                <div class="stat-label">Saved Venues</div>
            </div>
            <div class="stat-card">
                <div class="stat-value">${totalMatches * 2}</div>
                <div class="stat-label">Users Connected</div>
            </div>
        `;
    } catch (error) {
        console.error('Error loading usage stats:', error);
        usageStatsDiv.innerHTML = '<div class="loading">Error loading statistics</div>';
    }
}

async function loadSavedVenuesList() {
    const venuesListDiv = document.getElementById('saved-venues-list');
    
    try {
        await loadSavedVenues(); // Refresh venues
        
        if (savedVenues.length > 0) {
            venuesListDiv.innerHTML = savedVenues.map(venue => {
                const createdDate = new Date(venue.created_at).toLocaleDateString();
                return `
                    <div class="venue-detail-card">
                        <div class="venue-detail-info">
                            <div class="venue-detail-name">📍 ${venue.venue_name}</div>
                            <div class="venue-detail-address">${venue.venue_address || 'No address'}</div>
                            <div class="venue-detail-date">Added on ${createdDate}</div>
                        </div>
                        <button class="btn-remove-venue" onclick="removeVenue('${venue.id}')">Remove</button>
                    </div>
                `;
            }).join('');
        } else {
            venuesListDiv.innerHTML = `
                <div class="loading">
                    No venues saved yet. Add venues when creating events.
                </div>
            `;
        }
    } catch (error) {
        console.error('Error loading venues list:', error);
        venuesListDiv.innerHTML = '<div class="loading">Error loading venues</div>';
    }
}

async function removeVenue(venueId) {
    if (!confirm('Are you sure you want to remove this venue?')) return;
    
    try {
        const { error } = await supabase
            .from('organizer_venues')
            .delete()
            .eq('id', venueId)
            .eq('organizer_id', currentUser.id);
        
        if (error) throw error;
        
        showSuccess('Venue removed successfully', 'user-details-tab');
        await loadSavedVenuesList();
    } catch (error) {
        console.error('Error removing venue:', error);
        showError('Failed to remove venue', 'user-details-tab');
    }
}

function handleUpgrade() {
    // Redirect to website pricing page or show upgrade modal
    window.location.href = 'https://your-website.com/#pricing';
}

// ========================================
// VENUE MANAGEMENT
// ========================================

async function loadSavedVenues() {
    try {
        const { data: venues, error } = await supabase
            .from('organizer_venues')
            .select('*')
            .eq('organizer_id', currentUser.id)
            .order('created_at', { ascending: false });
        
        if (error) throw error;
        
        savedVenues = venues || [];
        console.log('Loaded venues:', savedVenues);
    } catch (error) {
        console.error('Error loading venues:', error);
        savedVenues = [];
    }
}

async function saveVenue(venueData) {
    try {
        // Check venue limits based on subscription tier
        const tier = currentOrganizer.subscription_tier || 'free';
        
        if (tier === 'free') {
            showError('Free accounts cannot save venues. Please upgrade to continue.');
            return null;
        }
        
        if (tier === 'basic' && savedVenues.length >= 1) {
            showError('Basic tier limit: You can only save 1 venue. Upgrade to Premium for unlimited venues.');
            return null;
        }
        
        const { data, error } = await supabase
            .from('organizer_venues')
            .insert({
                organizer_id: currentUser.id,
                venue_name: venueData.name,
                venue_address: venueData.address,
                place_id: venueData.place_id,
                lat: venueData.lat,
                lng: venueData.lng,
                venue_photo_url: venueData.photo_url // Store photo URL
            })
            .select()
            .single();
        
        if (error) throw error;
        
        savedVenues.unshift(data);
        return data;
    } catch (error) {
        console.error('Error saving venue:', error);
        if (error.message?.includes('Basic tier')) {
            showError(error.message);
        } else {
            showError('Failed to save venue');
        }
        return null;
    }
}

// ========================================
// EVENT MANAGEMENT
// ========================================

async function createEvent(eventData) {
    try {
        const { data: event, error: eventError } = await supabase
            .from('events')
            .insert({
                organizer_id: currentUser.id,
                name: eventData.name,
                venue_name: eventData.venue_name,
                venue_address: eventData.venue_address,
                place_id: eventData.place_id,
                lat: eventData.lat,
                lng: eventData.lng,
                venue_photo_url: eventData.venue_photo_url, // Store photo URL
                start_time: eventData.start_time,
                end_time: eventData.end_time,
                deck_size: eventData.deck_size,
                max_matches_allowed: eventData.max_matches_allowed,
                event_type: eventData.event_type,
                status: 'scheduled'
            })
            .select()
            .single();
        
        if (eventError) throw eventError;
        
        const { error: deckError } = await supabase
            .from('event_decks')
            .insert({
                event_id: event.id,
                male_cards_drawn: 0,
                female_cards_drawn: 0,
                universal_cards_drawn: 0
            });
        
        if (deckError) throw deckError;
        
        const { error: statsError } = await supabase
            .from('event_stats')
            .insert({
                event_id: event.id,
                active_males: 0,
                active_females: 0,
                total_matches_completed: 0
            });
        
        if (statsError) console.error('Error creating event stats:', statsError);
        
        return event;
    } catch (error) {
        console.error('Error creating event:', error);
        
        // Handle specific error messages from the trigger function
        if (error.message?.includes('Free accounts cannot create events')) {
            showError('Free accounts cannot create events. Please upgrade to continue.');
        } else if (error.message?.includes('Trial limit')) {
            showError('You\'ve already used your trial event. Please upgrade to continue.');
        } else if (error.message?.includes('Basic tier limit')) {
            showError('You\'ve reached your monthly limit of 4 events. Upgrade to Premium for unlimited events.');
        } else {
            showError('Failed to create event: ' + error.message);
        }
        return null;
    }
}

async function loadUpcomingEvents() {
    const eventsList = document.getElementById('upcoming-events-list');
    eventsList.innerHTML = '<div class="loading">Loading upcoming events...</div>';
    
    try {
        // Get events with 'scheduled' status
        const { data: events, error } = await supabase
            .from('events')
            .select('*, event_stats(*)')
            .eq('organizer_id', currentUser.id)
            .eq('status', 'scheduled') // Just check status field
            .order('start_time', { ascending: true });
        
        if (error) throw error;
        
        if (events && events.length > 0) {
            eventsList.innerHTML = events.map(event => {
                const startDate = new Date(event.start_time).toLocaleString();
                const endDate = new Date(event.end_time).toLocaleString();
                
                // Calculate time until start
                const now = new Date();
                const startTime = new Date(event.start_time);
                const timeUntilStart = startTime - now;
                const daysUntil = Math.floor(timeUntilStart / (1000 * 60 * 60 * 24));
                const hoursUntil = Math.floor((timeUntilStart % (1000 * 60 * 60 * 24)) / (1000 * 60 * 60));
                
                let timeUntilText = '';
                if (daysUntil > 0) {
                    timeUntilText = `Starts in ${daysUntil} day${daysUntil > 1 ? 's' : ''}, ${hoursUntil}h`;
                } else if (hoursUntil > 0) {
                    timeUntilText = `Starts in ${hoursUntil}h`;
                } else {
                    const minutesUntil = Math.floor(timeUntilStart / (1000 * 60));
                    timeUntilText = `Starts in ${minutesUntil}m`;
                }
                
                return `
                    <div class="upcoming-event-card">
                        <div class="event-name">
                            ${event.name}
                            <span class="event-status scheduled">SCHEDULED</span>
                        </div>
                        <div class="event-venue">📍 ${event.venue_name || event.venue_address}</div>
                        <div class="event-datetime">🕒 ${startDate} - ${endDate}</div>
                        <div class="event-time-remaining">⏰ ${timeUntilText}</div>
                        <div class="event-details">
                            <span class="event-detail">${event.event_type.toUpperCase()}</span>
                            <span class="event-detail">${event.deck_size} cards</span>
                            <span class="event-detail">Max ${event.max_matches_allowed} matches</span>
                        </div>
                        <div class="event-actions">
                            <button class="btn-edit" onclick="editEvent('${event.id}')">Edit</button>
                            <button class="btn-cancel" onclick="cancelEvent('${event.id}')">Cancel Event</button>
                        </div>
                    </div>
                `;
            }).join('');
        } else {
            eventsList.innerHTML = '<div class="loading">No upcoming events scheduled.</div>';
        }
    } catch (error) {
        console.error('Error loading upcoming events:', error);
        eventsList.innerHTML = '<div class="loading">Error loading events.</div>';
    }
}

async function loadEventHistory() {
    const eventsList = document.getElementById('events-list');
    eventsList.innerHTML = '<div class="loading">Loading past events...</div>';
    
    try {
        const { data: events, error } = await supabase
            .from('events')
            .select('*, event_stats(*)')
            .eq('organizer_id', currentUser.id)
            .in('status', ['completed', 'cancelled'])
            .order('start_time', { ascending: false });
        
        if (error) throw error;
        
        if (events && events.length > 0) {
            // For each event, get the actual user count and match data
            for (let event of events) {
                // Get unique users who participated
                const { data: participants, error: participantsError } = await supabase
                    .from('user_cards')
                    .select('user_id')
                    .eq('event_id', event.id);
                
                if (!participantsError && participants) {
                    const uniqueUsers = new Set(participants.map(p => p.user_id));
                    event.totalParticipants = uniqueUsers.size;
                } else {
                    event.totalParticipants = 0;
                }
                
                // Get successful matches count
                const { data: matches, error: matchesError } = await supabase
                    .from('matches')
                    .select('id')
                    .eq('event_id', event.id)
                    .not('match_completed_at', 'is', null);
                
                event.successfulMatches = matches ? matches.length : 0;
            }
            
            eventsList.innerHTML = events.map(event => {
                const startDate = new Date(event.start_time).toLocaleString();
                const endDate = new Date(event.end_time).toLocaleString();
                const stats = event.event_stats?.[0] || {};
                
                // Calculate match success rate
                const matchRate = event.totalParticipants > 0 
                    ? Math.round((event.successfulMatches * 2 / event.totalParticipants) * 100) 
                    : 0;
                
                return `
                    <div class="event-card ${event.status === 'cancelled' ? 'cancelled-event' : ''}">
                        <div class="event-header">
                            <div class="event-name">${event.name}</div>
                            <span class="event-status ${event.status}">${event.status.toUpperCase()}</span>
                        </div>
                        <div class="event-venue">📍 ${event.venue_name || event.venue_address}</div>
                        <div class="event-datetime">🕒 ${startDate} - ${endDate}</div>
                        <div class="event-details">
                            <span class="event-detail">${event.event_type.toUpperCase()}</span>
                            <span class="event-detail">${event.deck_size} cards</span>
                        </div>
                        ${event.status === 'completed' ? `
                            <div class="event-stats-summary">
                                <div class="stat-item">
                                    <span class="stat-icon">👥</span>
                                    <span class="stat-text">${event.totalParticipants} users participated</span>
                                </div>
                                <div class="stat-item">
                                    <span class="stat-icon">🎯</span>
                                    <span class="stat-text">${event.successfulMatches}/${event.max_matches_allowed} matches completed</span>
                                </div>
                                <div class="stat-item">
                                    <span class="stat-icon">📊</span>
                                    <span class="stat-text">${matchRate}% match rate</span>
                                </div>
                            </div>
                        ` : `
                            <div class="event-cancelled-info">
                                Event was cancelled before completion
                            </div>
                        `}
                    </div>
                `;
            }).join('');
        } else {
            eventsList.innerHTML = '<div class="loading">No past events found.</div>';
        }
    } catch (error) {
        console.error('Error loading events:', error);
        eventsList.innerHTML = '<div class="loading">Error loading events.</div>';
    }
}

// Load live events (currently active) - FIXED!
async function loadLiveEvents() {
    const eventsList = document.getElementById('live-events-list');
    eventsList.innerHTML = '<div class="loading">Loading live events...</div>';
    
    try {
        // Simply get events with 'active' status
        const { data: events, error } = await supabase
            .from('events')
            .select('*, event_stats(*)')
            .eq('organizer_id', currentUser.id)
            .eq('status', 'active') // Just check the status field
            .order('start_time', { ascending: true });
        
        if (error) throw error;
        
        if (events && events.length > 0) {
            eventsList.innerHTML = events.map(event => {
                const startDate = new Date(event.start_time).toLocaleString();
                const endDate = new Date(event.end_time).toLocaleString();
                const stats = event.event_stats?.[0] || {};
                
                // Calculate time remaining
                const now = new Date();
                const endTime = new Date(event.end_time);
                const timeRemaining = endTime - now;
                const hoursRemaining = Math.floor(timeRemaining / (1000 * 60 * 60));
                const minutesRemaining = Math.floor((timeRemaining % (1000 * 60 * 60)) / (1000 * 60));
                
                return `
                    <div class="upcoming-event-card live-event">
                        <div class="event-name">
                            ${event.name}
                            <span class="event-live-indicator">● LIVE</span>
                        </div>
                        <div class="event-venue">📍 ${event.venue_name || event.venue_address}</div>
                        <div class="event-datetime">🕒 Ends at ${new Date(event.end_time).toLocaleTimeString()}</div>
                        <div class="event-time-remaining">
                            ⏱️ ${hoursRemaining}h ${minutesRemaining}m remaining
                        </div>
                        <div class="event-details">
                            <span class="event-detail">${event.event_type.toUpperCase()}</span>
                            <span class="event-detail">${event.deck_size} cards</span>
                            <span class="event-detail">Max ${event.max_matches_allowed} matches</span>
                        </div>
                        <div class="event-stats-row">
                            <div class="event-stat">👥 ${(stats.active_males || 0) + (stats.active_females || 0)} active users</div>
                            <div class="event-stat">🎯 ${stats.total_matches_completed || 0}/${event.max_matches_allowed} matches</div>
                        </div>
                        <div class="event-actions">
                            <button class="btn-cancel" onclick="cancelEvent('${event.id}')">End Event</button>
                        </div>
                    </div>
                `;
            }).join('');
        } else {
            eventsList.innerHTML = '<div class="loading">No live events currently running.</div>';
        }
    } catch (error) {
        console.error('Error loading live events:', error);
        eventsList.innerHTML = '<div class="loading">Error loading live events.</div>';
    }
}

// FIXED: Complete event deletion instead of just status update
async function cancelEvent(eventId) {
    if (!confirm('Are you sure you want to cancel this event? This will permanently delete the event and all associated data.')) return;
    
    try {
        // Delete in correct order to respect foreign key constraints
        
        // 1. Delete vouchers first (references matches)
        const { error: vouchersError } = await supabase
            .from('vouchers')
            .delete()
            .eq('event_id', eventId);
        
        if (vouchersError) console.error('Error deleting vouchers:', vouchersError);
        
        // 2. Delete matches (references user_cards)
        const { error: matchesError } = await supabase
            .from('matches')
            .delete()
            .eq('event_id', eventId);
        
        if (matchesError) console.error('Error deleting matches:', matchesError);
        
        // 3. Delete user_cards
        const { error: cardsError } = await supabase
            .from('user_cards')
            .delete()
            .eq('event_id', eventId);
        
        if (cardsError) console.error('Error deleting user cards:', cardsError);
        
        // 4. Delete event_stats
        const { error: statsError } = await supabase
            .from('event_stats')
            .delete()
            .eq('event_id', eventId);
        
        if (statsError) console.error('Error deleting event stats:', statsError);
        
        // 5. Delete event_decks
        const { error: decksError } = await supabase
            .from('event_decks')
            .delete()
            .eq('event_id', eventId);
        
        if (decksError) console.error('Error deleting event decks:', decksError);
        
        // 6. Finally delete the event itself
        const { error: eventError } = await supabase
            .from('events')
            .delete()
            .eq('id', eventId)
            .eq('organizer_id', currentUser.id);
        
        if (eventError) throw eventError;
        
        showSuccess('Event deleted successfully');
        await loadUpcomingEvents();
        
    } catch (error) {
        console.error('Error cancelling event:', error);
        showError('Failed to delete event: ' + error.message);
    }
}

// Continue with rest of the functions (editEvent, updateEvent, viewStats, switchTab, etc.)
// [Rest of the code remains the same...]

async function editEvent(eventId) {
    try {
        const { data: event, error } = await supabase
            .from('events')
            .select('*')
            .eq('id', eventId)
            .single();
        
        if (error) throw error;
        
        document.getElementById('edit-event-id').value = event.id;
        document.getElementById('edit-event-name').value = event.name;
        document.getElementById('edit-venue-name').value = event.venue_name;
        document.getElementById('edit-start-time').value = event.start_time.slice(0, 16);
        document.getElementById('edit-end-time').value = event.end_time.slice(0, 16);
        document.getElementById('edit-deck-size').value = event.deck_size;
        document.getElementById('edit-max-matches').value = event.max_matches_allowed;
        document.getElementById('edit-event-type').value = event.event_type;
        
        document.getElementById('edit-modal').classList.add('active');
        
    } catch (error) {
        console.error('Error loading event for edit:', error);
        showError('Failed to load event details');
    }
}

function closeEditModal() {
    document.getElementById('edit-modal').classList.remove('active');
}

window.onclick = function(event) {
    const modal = document.getElementById('edit-modal');
    if (event.target == modal) {
        closeEditModal();
    }
}

function cancelEdit() {
    editingEventId = null;
    document.getElementById('event-form').reset();
    document.getElementById('submit-btn').textContent = 'Create Event';
    document.getElementById('cancel-edit-btn').style.display = 'none';
    document.querySelector('#events-tab h2').textContent = 'Create New Event';
    
    if (savedVenues.length > 0) {
        const venueInput = document.getElementById('venue-input');
        venueInput.value = savedVenues[0].venue_name;
        venueInput.classList.add('has-value');
        selectedVenue = savedVenues[0];
    }
    
    setDefaultDateTimes();
}

async function updateEvent(eventId, eventData) {
    try {
        const { data: event, error } = await supabase
            .from('events')
            .update({
                name: eventData.name,
                venue_name: eventData.venue_name,
                venue_address: eventData.venue_address,
                place_id: eventData.place_id,
                lat: eventData.lat,
                lng: eventData.lng,
                venue_photo_url: eventData.venue_photo_url, // Update photo URL
                start_time: eventData.start_time,
                end_time: eventData.end_time,
                deck_size: eventData.deck_size,
                max_matches_allowed: eventData.max_matches_allowed,
                event_type: eventData.event_type
            })
            .eq('id', eventId)
            .eq('organizer_id', currentUser.id)
            .select()
            .single();
        
        if (error) throw error;
        
        return event;
    } catch (error) {
        console.error('Error updating event:', error);
        throw error;
    }
}

function viewStats(eventId) {
    console.log('View stats for event:', eventId);
    showError('Live stats view coming soon!');
}

// ========================================
// TAB SWITCHING
// ========================================

function switchTab(tabName) {
    // Remove active class from all tabs and content
    document.querySelectorAll('.nav-tab').forEach(tab => tab.classList.remove('active'));
    document.querySelectorAll('.tab-content').forEach(content => content.classList.remove('active'));
    
    // Add active class to the specific tab based on exact match
    const tabButtons = document.querySelectorAll('.nav-tab');
    tabButtons.forEach((tab, index) => {
        if ((index === 0 && tabName === 'events') ||
            (index === 1 && tabName === 'live') ||
            (index === 2 && tabName === 'upcoming') ||
            (index === 3 && tabName === 'history') ||
            (index === 4 && tabName === 'user-details')) {
            tab.classList.add('active');
        }
    });
    
    // Show the corresponding content
    const contentId = tabName === 'user-details' ? 'user-details-tab' : tabName + '-tab';
    document.getElementById(contentId).classList.add('active');
    
    // Load content based on tab
    if (tabName === 'live') {
        loadLiveEvents();
    } else if (tabName === 'upcoming') {
        loadUpcomingEvents();
    } else if (tabName === 'history') {
        loadEventHistory();
    } else if (tabName === 'user-details') {
        loadUserDetails();
    } else if (tabName === 'events') {
        if (editingEventId) {
            cancelEdit();
        }
        // Refresh subscription status when switching to events tab
        checkSubscriptionStatus();
    }
}

// ========================================
// GOOGLE PLACES SEARCH WITH PHOTOS
// ========================================

async function searchGooglePlaces(query) {
    console.log('Starting Google Places search for:', query);
    
    try {
        const requestBody = {
            textQuery: query,
            maxResultCount: 10,
            regionCode: "IT",
            languageCode: 'it'
        };
        
        const response = await fetch(PLACES_API_BASE, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'X-Goog-Api-Key': GOOGLE_API_KEY,
                'X-Goog-FieldMask': 'places.displayName,places.formattedAddress,places.location,places.id,places.photos'
            },
            body: JSON.stringify(requestBody)
        });
        
        if (!response.ok) {
            const errorText = await response.text();
            console.error('Places API error:', errorText);
            return [];
        }
        
        const data = await response.json();
        console.log('Places found:', data.places?.length || 0);
        
        // Process places to get photo URLs
        if (data.places) {
            for (let place of data.places) {
                if (place.photos && place.photos.length > 0) {
                    // Get the first photo reference
                    const photoName = place.photos[0].name;
                    // Build the photo URL
                    place.photoUrl = `${PLACES_PHOTO_BASE}/${photoName}/media?maxHeightPx=400&maxWidthPx=400&key=${GOOGLE_API_KEY}`;
                }
            }
        }
        
        return data.places || [];
    } catch (error) {
        console.error('Network error fetching places:', error);
        return [];
    }
}

// [Rest of the venue input and helper functions remain the same...]

// ========================================
// VENUE INPUT INITIALIZATION
// ========================================

function initializeVenueInput() {
    const venueInput = document.getElementById('venue-input');
    const placesSuggestions = document.getElementById('places-suggestions');
    
    if (!venueInput) return;
    
    console.log('Venue input initialized');
    
    if (savedVenues.length > 0) {
        venueInput.value = savedVenues[0].venue_name;
        venueInput.classList.add('has-value');
        selectedVenue = savedVenues[0];
    }
    
    venueInput.addEventListener('input', function(e) {
        const query = e.target.value.trim();
        selectedVenue = null;
        
        if (searchTimeout) {
            clearTimeout(searchTimeout);
        }
        
        if (query.length === 0) {
            venueInput.classList.remove('has-value');
            showSavedVenues();
        } else {
            venueInput.classList.add('has-value');
            
            if (query.length > 1) {
                placesSuggestions.innerHTML = `
                    <div class="place-suggestion">
                        <div class="place-name">Searching...</div>
                    </div>
                `;
                placesSuggestions.classList.add('active');
                
                searchTimeout = setTimeout(async () => {
                    console.log('Searching for:', query);
                    const places = await searchGooglePlaces(query);
                    displaySearchResults(places, query);
                }, 300);
            }
        }
    });
    
    venueInput.addEventListener('focus', function() {
        if (!this.value) {
            showSavedVenues();
        }
    });
    
    venueInput.addEventListener('click', function(e) {
        if (this.value && savedVenues.length > 0) {
            e.stopPropagation();
            showSavedVenues();
        }
    });
    
    document.addEventListener('click', function(e) {
        if (!e.target.closest('.venue-dropdown-container')) {
            placesSuggestions.classList.remove('active');
        }
    });
}

function displaySearchResults(places, query) {
    const placesSuggestions = document.getElementById('places-suggestions');
    let html = '';
    
    const matchingSaved = savedVenues.filter(venue => 
        venue.venue_name.toLowerCase().includes(query.toLowerCase())
    );
    
    if (matchingSaved.length > 0) {
        html += '<div class="saved-venues-section">';
        html += '<div class="suggestion-header">Saved Venues</div>';
        matchingSaved.forEach(venue => {
            html += `
                <div class="venue-suggestion" onclick="selectSavedVenue('${venue.id}')">
                    <div class="venue-name">📍 ${venue.venue_name}</div>
                </div>
            `;
        });
        html += '</div>';
    }
    
    if (places.length > 0) {
        if (matchingSaved.length > 0) {
            html += '<div class="suggestion-header">Search Results</div>';
        }
        places.forEach(place => {
            const name = place.displayName?.text || 'Unknown Venue';
            const address = place.formattedAddress || '';
            const lat = place.location?.latitude || 0;
            const lng = place.location?.longitude || 0;
            const placeId = place.id || '';
            const photoUrl = place.photoUrl || '';
            
            const escapedName = name.replace(/'/g, "\\'");
            const escapedAddress = address.replace(/'/g, "\\'");
            const escapedPhotoUrl = photoUrl.replace(/'/g, "\\'");
            
            html += `
                <div class="place-suggestion" onclick="selectGooglePlace('${placeId}', '${escapedName}', '${escapedAddress}', ${lat}, ${lng}, '${escapedPhotoUrl}')">
                    <div class="place-name">${name}</div>
                    <div class="place-address">${address}</div>
                </div>
            `;
        });
    } else if (matchingSaved.length === 0) {
        html = `
            <div class="place-suggestion">
                <div class="place-name">No venues found</div>
                <div class="place-address">Try a different search term</div>
            </div>
        `;
    }
    
    placesSuggestions.innerHTML = html;
    placesSuggestions.classList.add('active');
}

function showSavedVenues() {
    const placesSuggestions = document.getElementById('places-suggestions');
    const venueInput = document.getElementById('venue-input');
    
    let html = '';
    
    if (savedVenues.length > 0) {
        html += '<div class="saved-venues-section">';
        html += '<div class="suggestion-header">Saved Venues</div>';
        savedVenues.forEach(venue => {
            html += `
                <div class="venue-suggestion" onclick="selectSavedVenue('${venue.id}')">
                    <div class="venue-name">📍 ${venue.venue_name}</div>
                </div>
            `;
        });
        html += '</div>';
        html += `
            <div class="add-new-venue-option" onclick="startNewVenueSearch()">
                ➕  Add new venue
            </div>
        `;
    } else if (!venueInput.value) {
        html = `
            <div class="place-suggestion">
                <div class="place-name">Start typing to search for venues...</div>
            </div>
        `;
    }
    
    if (html) {
        placesSuggestions.innerHTML = html;
        placesSuggestions.classList.add('active');
    }
}

function selectSavedVenue(venueId) {
    const venue = savedVenues.find(v => v.id === venueId);
    if (venue) {
        const venueInput = document.getElementById('venue-input');
        const placesSuggestions = document.getElementById('places-suggestions');
        
        venueInput.value = venue.venue_name;
        venueInput.classList.add('has-value');
        selectedVenue = venue;
        placesSuggestions.classList.remove('active');
    }
}

// Updated to include photo URL
async function selectGooglePlace(placeId, name, address, lat, lng, photoUrl) {
    const venueInput = document.getElementById('venue-input');
    const placesSuggestions = document.getElementById('places-suggestions');
    
    venueInput.value = name;
    venueInput.classList.add('has-value');
    
    const existingVenue = savedVenues.find(v => v.place_id === placeId);
    
    if (existingVenue) {
        selectedVenue = existingVenue;
    } else {
        selectedVenue = {
            id: null,
            venue_name: name,
            venue_address: address,
            lat: lat,
            lng: lng,
            place_id: placeId,
            photo_url: photoUrl, // Add photo URL
            isNew: true
        };
    }
    
    placesSuggestions.classList.remove('active');
    console.log('Selected venue with photo:', selectedVenue);
}

function startNewVenueSearch() {
    const venueInput = document.getElementById('venue-input');
    const placesSuggestions = document.getElementById('places-suggestions');
    
    venueInput.value = '';
    venueInput.classList.remove('has-value');
    venueInput.focus();
    placesSuggestions.classList.remove('active');
}

// ========================================
// HELPER FUNCTIONS
// ========================================

function setDefaultDateTimes() {
    const now = new Date();
    const startTime = new Date(now.getTime() + 2 * 60 * 60 * 1000);
    const endTime = new Date(startTime.getTime() + 4 * 60 * 60 * 1000);
    
    document.getElementById('start-time').value = startTime.toISOString().slice(0, 16);
    document.getElementById('end-time').value = endTime.toISOString().slice(0, 16);
    
    const dateInputs = document.querySelectorAll('input[type="datetime-local"]');
    dateInputs.forEach(input => {
        input.addEventListener('click', function(e) {
            if (e.target === this) {
                try {
                    this.showPicker();
                } catch (error) {
                    this.focus();
                    this.click();
                }
            }
        });
    });
}

function showError(message, containerId = 'events-tab') {
    const container = document.getElementById(containerId);
    const existingError = container.querySelector('.error');
    if (existingError) existingError.remove();
    
    const errorDiv = document.createElement('div');
    errorDiv.className = 'error';
    errorDiv.textContent = message;
    container.insertBefore(errorDiv, container.firstChild);
    
    setTimeout(() => errorDiv.remove(), 5000);
}

function showSuccess(message, containerId = 'events-tab') {
    const container = document.getElementById(containerId);
    const existingSuccess = container.querySelector('.success');
    if (existingSuccess) existingSuccess.remove();
    
    const successDiv = document.createElement('div');
    successDiv.className = 'success';
    successDiv.textContent = message;
    container.insertBefore(successDiv, container.firstChild);
    
    setTimeout(() => successDiv.remove(), 5000);
}