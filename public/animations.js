/**
 * Hr Analyzer - GSAP Animation System
 * Professional, smooth animations for the Bento-inspired UI
 */

class HrAnalyzerAnimations {
    constructor() {
        this.isInitialized = false;
        this.currentView = null;
        this.timeline = null;
        this.scrollTriggers = [];
    }

    async init() {
        // Wait for GSAP to load
        if (typeof gsap === 'undefined') {
            console.warn('GSAP not loaded, animations disabled');
            return;
        }

        // Set default easing
        gsap.defaults({
            ease: 'power3.out',
            duration: 0.6
        });

        // Initialize page load animation
        this.pageLoadAnimation();
        this.isInitialized = true;
    }

    // =====================
    // Page Load Animation
    // =====================
    pageLoadAnimation() {
        const tl = gsap.timeline();

        // Fade in the app container
        tl.fromTo('#app', 
            { opacity: 0 },
            { opacity: 1, duration: 0.4 }
        );

        // Slide in sidebar
        tl.fromTo('.sidebar',
            { x: -280, opacity: 0 },
            { x: 0, opacity: 1, duration: 0.5, ease: 'power2.out' },
            '-=0.2'
        );

        // Fade in header
        tl.fromTo('.nav-header',
            { y: -60, opacity: 0 },
            { y: 0, opacity: 1, duration: 0.4 },
            '-=0.3'
        );

        // Stagger nav links
        tl.fromTo('.nav-link',
            { x: -30, opacity: 0 },
            { x: 0, opacity: 1, stagger: 0.08, duration: 0.4 },
            '-=0.2'
        );

        // Animate main content
        tl.fromTo('.main-content',
            { opacity: 0 },
            { opacity: 1, duration: 0.3 },
            '-=0.3'
        );

        return tl;
    }

    // =====================
    // View Transition
    // =====================
    async transitionToView(fromView, toView) {
        if (!this.isInitialized) {
            // Fallback: just show/hide
            if (fromView) fromView.classList.add('hidden');
            if (toView) toView.classList.remove('hidden');
            return;
        }

        const tl = gsap.timeline();

        // Exit animation for current view
        if (fromView && !fromView.classList.contains('hidden')) {
            tl.to(fromView, {
                opacity: 0,
                y: -20,
                duration: 0.25,
                ease: 'power2.in',
                onComplete: () => fromView.classList.add('hidden')
            });
        }

        // Enter animation for new view
        if (toView) {
            toView.classList.remove('hidden');
            
            tl.fromTo(toView,
                { opacity: 0, y: 30 },
                { opacity: 1, y: 0, duration: 0.4, ease: 'power2.out' },
                fromView ? '-=0.1' : 0
            );

            // Animate bento tiles if present
            const bentoTiles = toView.querySelectorAll('.bento-tile, .task-card, .tool-preview-card, .settings-card');
            if (bentoTiles.length > 0) {
                tl.fromTo(bentoTiles,
                    { opacity: 0, y: 40, scale: 0.95 },
                    { 
                        opacity: 1, 
                        y: 0, 
                        scale: 1,
                        stagger: 0.06,
                        duration: 0.5,
                        ease: 'power3.out'
                    },
                    '-=0.2'
                );
            }

            // Animate section headers
            const headers = toView.querySelectorAll('.section-header, .welcome-content');
            if (headers.length > 0) {
                tl.fromTo(headers,
                    { opacity: 0, y: 20 },
                    { opacity: 1, y: 0, duration: 0.4 },
                    '-=0.4'
                );
            }
        }

        this.currentView = toView;
        return tl;
    }

    // =====================
    // Section Transitions
    // =====================
    showSection(section) {
        if (!section || !this.isInitialized) {
            if (section) section.classList.remove('hidden');
            return;
        }

        section.classList.remove('hidden');
        
        const tl = gsap.timeline();
        
        tl.fromTo(section,
            { opacity: 0, y: 30 },
            { opacity: 1, y: 0, duration: 0.5 }
        );

        // Animate child cards
        const cards = section.querySelectorAll('.bento-tile, .task-card, .result-card, .candidate-card');
        if (cards.length > 0) {
            tl.fromTo(cards,
                { opacity: 0, y: 30, scale: 0.96 },
                { 
                    opacity: 1, 
                    y: 0, 
                    scale: 1,
                    stagger: 0.05,
                    duration: 0.4
                },
                '-=0.3'
            );
        }

        return tl;
    }

    hideSection(section) {
        if (!section || !this.isInitialized) {
            if (section) section.classList.add('hidden');
            return Promise.resolve();
        }

        return new Promise(resolve => {
            gsap.to(section, {
                opacity: 0,
                y: -20,
                duration: 0.25,
                ease: 'power2.in',
                onComplete: () => {
                    section.classList.add('hidden');
                    gsap.set(section, { opacity: 1, y: 0 });
                    resolve();
                }
            });
        });
    }

    // =====================
    // Modal Animations
    // =====================
    openModal(modal) {
        if (!modal) return;

        modal.classList.remove('hidden');

        if (!this.isInitialized) return;

        const content = modal.querySelector('.modal-content');
        
        const tl = gsap.timeline();
        
        // Fade in overlay
        tl.fromTo(modal,
            { opacity: 0 },
            { opacity: 1, duration: 0.25 }
        );

        // Scale and fade content
        if (content) {
            tl.fromTo(content,
                { opacity: 0, scale: 0.9, y: 30 },
                { opacity: 1, scale: 1, y: 0, duration: 0.35, ease: 'back.out(1.2)' },
                '-=0.15'
            );
        }

        return tl;
    }

    closeModal(modal) {
        if (!modal) return Promise.resolve();

        if (!this.isInitialized) {
            modal.classList.add('hidden');
            return Promise.resolve();
        }

        const content = modal.querySelector('.modal-content');
        
        return new Promise(resolve => {
            const tl = gsap.timeline({
                onComplete: () => {
                    modal.classList.add('hidden');
                    gsap.set(modal, { opacity: 1 });
                    if (content) gsap.set(content, { opacity: 1, scale: 1, y: 0 });
                    resolve();
                }
            });

            if (content) {
                tl.to(content, {
                    opacity: 0,
                    scale: 0.95,
                    y: -20,
                    duration: 0.2,
                    ease: 'power2.in'
                });
            }

            tl.to(modal, {
                opacity: 0,
                duration: 0.2
            }, '-=0.1');
        });
    }

    // =====================
    // Notification Animations
    // =====================
    showNotification(notification) {
        if (!notification) return;

        notification.classList.remove('hidden');

        if (!this.isInitialized) return;

        gsap.fromTo(notification,
            { x: 100, opacity: 0 },
            { x: 0, opacity: 1, duration: 0.4, ease: 'power3.out' }
        );
    }

    hideNotification(notification) {
        if (!notification) return Promise.resolve();

        if (!this.isInitialized) {
            notification.classList.add('hidden');
            return Promise.resolve();
        }

        return new Promise(resolve => {
            gsap.to(notification, {
                x: 100,
                opacity: 0,
                duration: 0.3,
                ease: 'power2.in',
                onComplete: () => {
                    notification.classList.add('hidden');
                    gsap.set(notification, { x: 0, opacity: 1 });
                    resolve();
                }
            });
        });
    }

    // =====================
    // Progress Bar Animation
    // =====================
    animateProgress(element, toPercent) {
        if (!element) return;

        if (!this.isInitialized) {
            element.style.width = `${toPercent}%`;
            return;
        }

        gsap.to(element, {
            width: `${toPercent}%`,
            duration: 0.5,
            ease: 'power2.out'
        });
    }

    // =====================
    // Card Hover Effects
    // =====================
    setupCardHovers() {
        if (!this.isInitialized) return;

        const cards = document.querySelectorAll('.bento-tile, .task-card, .tool-preview-card');
        
        cards.forEach(card => {
            card.addEventListener('mouseenter', () => {
                gsap.to(card, {
                    y: -6,
                    scale: 1.02,
                    duration: 0.3,
                    ease: 'power2.out'
                });
            });

            card.addEventListener('mouseleave', () => {
                gsap.to(card, {
                    y: 0,
                    scale: 1,
                    duration: 0.3,
                    ease: 'power2.out'
                });
            });
        });
    }

    // =====================
    // File Drop Zone Animation
    // =====================
    animateDropZone(zone, isDragging) {
        if (!zone || !this.isInitialized) return;

        if (isDragging) {
            gsap.to(zone, {
                scale: 1.02,
                borderColor: 'rgba(99, 102, 241, 0.6)',
                duration: 0.2
            });
        } else {
            gsap.to(zone, {
                scale: 1,
                borderColor: 'rgba(255, 255, 255, 0.1)',
                duration: 0.2
            });
        }
    }

    // =====================
    // Results Animation
    // =====================
    animateResults(container) {
        if (!container || !this.isInitialized) return;

        const cards = container.querySelectorAll('.result-card, .candidate-card');
        
        gsap.fromTo(cards,
            { opacity: 0, y: 40, scale: 0.95 },
            {
                opacity: 1,
                y: 0,
                scale: 1,
                stagger: 0.04,
                duration: 0.4,
                ease: 'power3.out'
            }
        );
    }

    // =====================
    // Number Counter Animation
    // =====================
    animateNumber(element, toValue, duration = 1) {
        if (!element) return;

        if (!this.isInitialized) {
            element.textContent = toValue;
            return;
        }

        const obj = { value: 0 };
        gsap.to(obj, {
            value: toValue,
            duration: duration,
            ease: 'power2.out',
            onUpdate: () => {
                element.textContent = Math.round(obj.value);
            }
        });
    }

    // =====================
    // Loading Overlay Animation
    // =====================
    showLoading(overlay) {
        if (!overlay) return;

        overlay.classList.remove('hidden');

        if (!this.isInitialized) return;

        const spinner = overlay.querySelector('.loading-spinner');
        
        gsap.fromTo(overlay,
            { opacity: 0 },
            { opacity: 1, duration: 0.3 }
        );

        if (spinner) {
            gsap.fromTo(spinner,
                { scale: 0.8, rotation: -90 },
                { scale: 1, rotation: 0, duration: 0.4, ease: 'back.out(1.5)' }
            );
        }
    }

    hideLoading(overlay) {
        if (!overlay) return Promise.resolve();

        if (!this.isInitialized) {
            overlay.classList.add('hidden');
            return Promise.resolve();
        }

        return new Promise(resolve => {
            gsap.to(overlay, {
                opacity: 0,
                duration: 0.25,
                onComplete: () => {
                    overlay.classList.add('hidden');
                    gsap.set(overlay, { opacity: 1 });
                    resolve();
                }
            });
        });
    }

    // =====================
    // Theme Studio Animation
    // =====================
    toggleThemeStudio(studio, isOpen) {
        if (!studio) return;

        if (!this.isInitialized) {
            studio.classList.toggle('hidden', !isOpen);
            return;
        }

        if (isOpen) {
            studio.classList.remove('hidden');
            gsap.fromTo(studio,
                { opacity: 0, y: 30, scale: 0.9 },
                { opacity: 1, y: 0, scale: 1, duration: 0.4, ease: 'back.out(1.3)' }
            );
        } else {
            gsap.to(studio, {
                opacity: 0,
                y: 20,
                scale: 0.95,
                duration: 0.25,
                ease: 'power2.in',
                onComplete: () => {
                    studio.classList.add('hidden');
                    gsap.set(studio, { opacity: 1, y: 0, scale: 1 });
                }
            });
        }
    }

    // =====================
    // Sidebar Mobile Animation
    // =====================
    toggleSidebar(sidebar, overlay, isOpen) {
        if (!sidebar) return;

        if (!this.isInitialized) {
            sidebar.classList.toggle('mobile-open', isOpen);
            if (overlay) overlay.classList.toggle('active', isOpen);
            return;
        }

        if (isOpen) {
            sidebar.classList.add('mobile-open');
            if (overlay) overlay.classList.add('active');
            
            gsap.fromTo(sidebar,
                { x: -280 },
                { x: 0, duration: 0.35, ease: 'power2.out' }
            );

            if (overlay) {
                gsap.fromTo(overlay,
                    { opacity: 0 },
                    { opacity: 1, duration: 0.3 }
                );
            }
        } else {
            gsap.to(sidebar, {
                x: -280,
                duration: 0.3,
                ease: 'power2.in',
                onComplete: () => sidebar.classList.remove('mobile-open')
            });

            if (overlay) {
                gsap.to(overlay, {
                    opacity: 0,
                    duration: 0.25,
                    onComplete: () => overlay.classList.remove('active')
                });
            }
        }
    }

    // =====================
    // Pulse Animation for Status
    // =====================
    pulseElement(element) {
        if (!element || !this.isInitialized) return;

        gsap.fromTo(element,
            { scale: 1 },
            {
                scale: 1.1,
                duration: 0.3,
                yoyo: true,
                repeat: 1,
                ease: 'power2.inOut'
            }
        );
    }

    // =====================
    // Stagger List Items
    // =====================
    staggerList(items, options = {}) {
        if (!items || items.length === 0 || !this.isInitialized) return;

        const defaults = {
            y: 20,
            opacity: 0,
            stagger: 0.05,
            duration: 0.4
        };

        const settings = { ...defaults, ...options };

        gsap.fromTo(items,
            { y: settings.y, opacity: 0 },
            {
                y: 0,
                opacity: 1,
                stagger: settings.stagger,
                duration: settings.duration,
                ease: 'power3.out'
            }
        );
    }
}

// Create global instance (keep legacy alias for compatibility)
window.hrAnimations = new HrAnalyzerAnimations();
window.chunAnimations = window.hrAnimations;

// Initialize on DOM ready
document.addEventListener('DOMContentLoaded', () => {
    // Small delay to ensure GSAP is loaded
    setTimeout(() => {
        window.hrAnimations.init();
    }, 100);
});
