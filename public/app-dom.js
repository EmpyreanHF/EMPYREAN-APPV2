// =====================================================
        // FIREBASE — use globals set by head initialization
        // =====================================================
        // Re-attempt init in case SDK loaded after head script ran
        if (!window._firebaseLoaded && typeof firebase !== 'undefined') {
            window._initFirebase();
        }
        // Local aliases that always point to working implementations
        let fbAuth    = window.fbAuth;
        let fbDb      = window.fbDb;
        let fbStorage = window.fbStorage;
        // Keep them in sync if Firebase loads asynchronously
        Object.defineProperty(window, 'fbAuth',    { get: () => fbAuth,    set: v => { fbAuth = v; },    configurable: true });
        Object.defineProperty(window, 'fbDb',      { get: () => fbDb,      set: v => { fbDb = v; },      configurable: true });
        Object.defineProperty(window, 'fbStorage', { get: () => fbStorage, set: v => { fbStorage = v; }, configurable: true });

        function _serverTimestamp() {
            try {
                if (typeof firebase !== 'undefined' && firebase.firestore && firebase.firestore.FieldValue)
                    return firebase.firestore.FieldValue.serverTimestamp();
            } catch(e) {}
            return new Date();
        }

        // =====================================================
        // CLOUDINARY CONFIG — loaded from /api/config (no keys in source)
        // =====================================================
        // Config is read at upload time (not script load time) to ensure
        // _appConfig has been populated by the async /api/config fetch.
        function _getCloudinaryConfig() {
            const _cloud = window._appConfig && window._appConfig.cloudinary;
            const cloud  = (_cloud && _cloud.cloud)  || '';
            const preset = (_cloud && _cloud.preset) || '';
            const url    = cloud
                ? 'https://api.cloudinary.com/v1_1/' + cloud + '/auto/upload'
                : '';
            return { cloud, preset, url };
        }

        // Wait up to maxMs for /api/config cloudinary keys to be populated.
        // Solves race: upload triggered before fetch('/api/config') resolves.
        function _waitForCloudinaryConfig(maxMs) {
            maxMs = maxMs || 12000;
            const start = Date.now();
            return new Promise(function(resolve) {
                (function poll() {
                    const cfg = _getCloudinaryConfig();
                    if (cfg.cloud && cfg.preset && cfg.url) return resolve(cfg);
                    if (Date.now() - start > maxMs) return resolve(null);
                    setTimeout(poll, 200);
                })();
            });
        }

        // Expose uploadToCloudinary globally so secondary scripts can call it
        window.uploadToCloudinary = async function uploadToCloudinary(file, onProgress) {
            if (!file) return '';
            // Already a URL string — return as-is
            if (typeof file === 'string') return file;
            // Not a real File/Blob — try to extract a URL
            if (!(file instanceof File) && !(file instanceof Blob)) {
                return file._cloudUrl || file.url || '';
            }
            // Re-use already-uploaded cloud URL for this File object
            if (file._cloudUrl && !file._cloudUrl.startsWith('blob:')) return file._cloudUrl;

            // Always create a local blob URL as immediate fallback
            const localUrl = URL.createObjectURL(file);

            // Wait for /api/config to deliver Cloudinary credentials
            const cfg = await _waitForCloudinaryConfig(12000);
            if (!cfg) {
                console.warn('[Cloudinary] Config not available after 12s — using local blob URL');
                file._cloudUrl = localUrl;
                return localUrl;
            }

            return new Promise((resolve) => {
                // Hard timeout: if Cloudinary takes >20s resolve with blob URL
                const fallbackTimer = setTimeout(() => {
                    console.warn('[Upload] Cloud upload timed out — using local URL');
                    file._cloudUrl = localUrl;
                    resolve(localUrl);
                }, 20000);

                const fd = new FormData();
                fd.append('file', file);
                fd.append('upload_preset', cfg.preset);
                fd.append('tags', 'empyrean_app');
                const xhr = new XMLHttpRequest();
                xhr.open('POST', cfg.url, true);
                xhr.upload.onprogress = (e) => {
                    if (e.lengthComputable) {
                        const pct = Math.round((e.loaded / e.total) * 100);
                        if (onProgress) onProgress(pct);
                        document.querySelectorAll('.upload-progress-bar').forEach(bar => {
                            bar.style.width = pct + '%';
                            bar.style.background = 'linear-gradient(90deg,#00897B,#4CAF50)';
                        });
                    }
                };
                xhr.onload = () => {
                    clearTimeout(fallbackTimer);
                    if (xhr.status === 200) {
                        try {
                            const res = JSON.parse(xhr.responseText);
                            const cloudUrl = res.secure_url || localUrl;
                            // Upload monitoring log
                            console.info('[Cloudinary] ✅ Upload successful:', {
                                public_id: res.public_id,
                                format: res.format,
                                size_kb: Math.round((res.bytes||0)/1024),
                                url: cloudUrl.substring(0, 60) + '...'
                            });
                            // Track upload count for monitoring
                            window._cloudinaryUploads = (window._cloudinaryUploads || 0) + 1;
                            file._cloudUrl = cloudUrl;
                            resolve(cloudUrl);
                        } catch(e) { file._cloudUrl = localUrl; resolve(localUrl); }
                    } else {
                        console.warn('[Cloudinary] ⚠ Upload error ' + xhr.status + ' — using local blob URL');
                        file._cloudUrl = localUrl;
                        resolve(localUrl);
                    }
                };
                xhr.onerror = () => { clearTimeout(fallbackTimer); file._cloudUrl = localUrl; resolve(localUrl); };
                xhr.ontimeout = () => { clearTimeout(fallbackTimer); file._cloudUrl = localUrl; resolve(localUrl); };
                xhr.timeout = 20000;
                xhr.send(fd);
            });
        };
        const uploadToCloudinary = window.uploadToCloudinary;

        async function uploadMediaFilesToCloudinary(files, onProgress) {
            if (!files || files.length === 0) return [];
            const uploads = Array.from(files).map(async (file, idx) => {
                if (!(file instanceof File) && !(file instanceof Blob)) {
                    return file._cloudUrl || (typeof file === 'string' ? file : (file.url || ''));
                }
                // Validate file size (max 100MB)
                if (file.size > 100 * 1024 * 1024) {
                    if (typeof showNotification === 'function') showNotification(`"${file.name}" is too large (max 100MB).`, 'error');
                    return URL.createObjectURL(file);
                }
                try {
                    const url = await window.uploadToCloudinary(file, (pct) => {
                        if (onProgress) onProgress(idx, pct);
                    });
                    file._cloudUrl = url;
                    return url;
                } catch(err) {
                    console.warn('Upload error for file', file.name, err.message);
                    if (typeof showNotification === 'function') showNotification('Upload failed: ' + err.message, 'error');
                    return file._cloudUrl || URL.createObjectURL(file);
                }
            });
            return Promise.all(uploads);
        }
        window.uploadMediaFilesToCloudinary = uploadMediaFilesToCloudinary;

        // =====================================================
        // FLUTTERWAVE PAYMENT GATEWAY — keys from /api/config
        // =====================================================
        // Read public key lazily at payment time so /api/config has resolved.
        // FLW_SECRET_KEY and FLW_ENCRYPTION_KEY live only on the server.
        // Transaction verification is proxied through /api/flw/verify.
        function initiateFlutterwavePayment(opts) {
            const FLW_PUBLIC_KEY = (window._appConfig && window._appConfig.flutterwave && window._appConfig.flutterwave.publicKey) || '';
            const txRef = 'EMPY-' + Date.now() + '-' + Math.floor(Math.random()*10000);
            if (typeof FlutterwaveCheckout === 'undefined') {
                console.warn('Flutterwave not loaded — retrying...');
                // Dynamically load if missed on page load
                const s = document.createElement('script');
                s.src = 'https://checkout.flutterwave.com/v3.js';
                s.onload = function() { initiateFlutterwavePayment(opts); };
                s.onerror = function() { if (opts.onFailure) opts.onFailure({ status: 'error', message: 'Payment gateway unavailable' }); };
                document.body.appendChild(s);
                return;
            }
            FlutterwaveCheckout({
                public_key: FLW_PUBLIC_KEY,
                tx_ref: txRef,
                amount: opts.amount,
                currency: opts.currency || 'NGN',
                payment_options: 'card,ussd,banktransfer,mobilemoney',
                customer: {
                    email: opts.email || (window.userState && window.userState.email) || 'user@empyrean.com',
                    phone_number: opts.phone || (window.userState && window.userState.phone) || '',
                    name: opts.name || (window.userState && window.userState.fullName) || 'Empyrean User'
                },
                customizations: {
                    title: 'Empyrean Humanitarian Platform',
                    description: opts.description || 'Payment',
                    logo: window._empyreanLogoSrc || ''
                },
                meta: { verified_server_side: true },   // verification via /api/flw/verify
                callback: function(response) {
                    if (response.status === 'successful') {
                        fbDb.collection('flw_transactions').doc(txRef).set({
                            txRef, amount: opts.amount, currency: opts.currency || 'NGN',
                            purpose: opts.purpose || 'general', status: 'held',
                            createdAt: _serverTimestamp()
                        }).catch(e => console.error('FLW tx save error:', e));
                        if (opts.onSuccess) opts.onSuccess(response, txRef);
                    } else {
                        if (opts.onFailure) opts.onFailure(response);
                    }
                },
                onclose: function() { if (opts.onClose) opts.onClose(); }
            });
        }

        // Firebase user helpers
        async function saveUserToFirestore(uid, userData) {
            // Ensure real Firebase is ready before saving
            if (!window._firebaseLoaded) {
                console.warn('[saveUser] Firebase not ready — queuing retry in 2s');
                return new Promise((resolve) => {
                    setTimeout(async () => { try { await saveUserToFirestore(uid, userData); } catch(e){} resolve(); }, 2000);
                });
            }
            const safe = { ...userData };
            ['likedPostIds','followedUserIds','retweetedPostIds','awardedRanks','completedTasks','viewedStatusUserIds']
                .forEach(k => { if (safe[k] instanceof Set) safe[k] = [...safe[k]]; });
            delete safe.password;
            safe.updatedAt = _serverTimestamp();
            try {
                await fbDb.collection('users').doc(uid).set(safe, { merge: true });
                console.log('[Firestore] ✅ User profile saved for uid:', uid);
            } catch(err) {
                console.error('[Firestore] ❌ User save failed:', err.message);
                throw err;
            }
        }
        async function loadUserFromFirestore(uid) {
            const doc = await fbDb.collection('users').doc(uid).get();
            if (!doc.exists) return null;
            const data = doc.data();
            ['likedPostIds','followedUserIds','retweetedPostIds','awardedRanks','completedTasks','viewedStatusUserIds']
                .forEach(k => { data[k] = new Set(data[k] || []); });
            return data;
        }