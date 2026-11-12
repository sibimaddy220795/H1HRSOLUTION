const families = [
  { key: 'small', match: (plan) => plan.family === 'Small' && !plan.id.startsWith('hr-blue') },
  { key: 'warehouse', match: (plan) => plan.id.startsWith('hr-blue') },
  { key: 'medium', match: (plan) => plan.family === 'Medium' },
  { key: 'large', match: (plan) => plan.family === 'Large' }
];

function esc(value) {
  return String(value ?? '').replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
}

async function readJson(pending) {
  const response = await pending;
  const body = await response.json();
  if (!response.ok || !body.success) throw new Error(body.error || 'The desk could not take that request');
  return body.data;
}

function bindForm(id, noteId, send, successMsg) {
  const form = document.getElementById(id);
  const note = document.getElementById(noteId);
  if (!form || !note) return;

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    note.hidden = true;
    note.className = 'form-notification';
    const button = form.querySelector('button[type="submit"]');
    if (button) button.disabled = true;

    try {
      await send(form);
      form.reset();
      note.hidden = false;
      note.className = 'form-notification form-success';
      note.textContent = successMsg || 'Thank you! Your submission has been received. Our team will contact you shortly.';
    } catch (error) {
      note.hidden = false;
      note.className = 'form-notification form-error';
      note.textContent = error.message || 'Something went wrong. Please check your inputs and try again.';
    } finally {
      if (button) button.disabled = false;
    }
  });
}

// Fetch plans if available, updating dynamically while preserving defaults if empty
fetch('/api/public/plans')
  .then((response) => response.json())
  .then((body) => {
    const catalog = body.data || [];
    if (!catalog.length) return;
    document.querySelectorAll('[data-plans]').forEach((list) => {
      const familyKey = list.dataset.plans;
      const matched = families.find((family) => family.key === familyKey);
      if (matched) {
        const plans = catalog.filter(matched.match);
        if (plans.length > 0) {
          list.innerHTML = plans.map((plan) => `<li>${esc(plan.name)}</li>`).join('');
        }
      }
    });
  })
  .catch(() => {});

function setText(id, value) {
  const node = document.getElementById(id);
  if (node && value != null) node.textContent = value;
}

// Fetch live story / stats
fetch('/api/public/story')
  .then((response) => response.json())
  .then((body) => {
    const story = body.data || {};
    if (story.people) setText('stat-people', Number(story.people).toLocaleString());
    if (story.companies) setText('stat-companies', story.companies);
    if (story.rating) setText('stat-rating', story.rating);
    if (story.rating) setText('hiring-rating', story.rating);
  })
  .catch(() => {});

// Bind Demo Form
bindForm('demo-form', 'demo-note', (form) => readJson(fetch('/api/public/demo', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(Object.fromEntries(new FormData(form).entries()))
})), 'Demo enquiry received! The Runwork team will reach out to you with your personalised walkthrough.');

// Bind Newsletter Form if present
bindForm('news-form', 'news-note', (form) => readJson(fetch('/api/public/newsletter', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(Object.fromEntries(new FormData(form).entries()))
})), 'Subscribed successfully! You will receive periodic workspace updates.');

// Bind Hiring / Business Enquiry Form
bindForm('apply-form', 'apply-note', (form) => readJson(fetch('/api/public/apply', {
  method: 'POST',
  body: new FormData(form)
})), 'Enquiry submitted successfully! Our talent and partnerships desk has received your details.');

// Interactive Navigation highlighting
document.addEventListener('DOMContentLoaded', () => {
  const sections = document.querySelectorAll('section[id], div[id]');
  const navLinks = document.querySelectorAll('.main-nav .nav-link');

  window.addEventListener('scroll', () => {
    let currentId = '';
    const scrollPos = window.scrollY + 100;
    sections.forEach((sec) => {
      const top = sec.offsetTop;
      const height = sec.offsetHeight;
      if (scrollPos >= top && scrollPos < top + height) {
        currentId = sec.getAttribute('id');
      }
    });

    if (currentId) {
      navLinks.forEach((link) => {
        link.classList.toggle('active', link.getAttribute('href') === `#${currentId}`);
      });
    }
  });

  // Business Admin Board Mockup Tab Switcher
  const bnavItems = document.querySelectorAll('.bnav-item');
  bnavItems.forEach((btn) => {
    btn.addEventListener('click', () => {
      bnavItems.forEach((b) => b.classList.remove('active'));
      btn.classList.add('active');
    });
  });

  // ==================== INTERACTIVE PILLAR & RUNWORK ONE CARDS (HOVER POPUPS & EXPLANATION NOTES) ====================
  const interactiveCards = document.querySelectorAll('.pillar-card, .key-feat-card');
  const toast = document.getElementById('pillar-hover-toast');
  const toastTitle = document.getElementById('toast-title');
  const toastDesc = document.getElementById('toast-desc');
  const modal = document.getElementById('pillar-modal');
  const modalBody = document.getElementById('pillar-modal-body');
  const modalClose = document.getElementById('pillar-modal-close');
  const modalBackdrop = document.getElementById('pillar-modal-backdrop');
  let toastTimer = null;

  function updatePillarPlacement(card) {
    const rect = card.getBoundingClientRect();
    // If less than 360px available above the card, position popup below
    if (rect.top < 360) {
      card.classList.add('popup-below');
    } else {
      card.classList.remove('popup-below');
    }
  }

  function showInteractiveCardModal(card) {
    const title = card.querySelector('.popup-title')?.textContent || card.querySelector('h3, h4')?.textContent || '';
    const category = card.querySelector('.popup-category')?.textContent || 'Runwork Capability';
    const summary = card.querySelector('.popup-summary')?.textContent || card.querySelector('p')?.textContent || '';
    const notesListHtml = card.querySelector('.popup-notes-list')?.innerHTML || '';
    const pillsHtml = card.querySelector('.popup-pills-row')?.innerHTML || '';
    const iconHtml = card.querySelector('.pillar-icon')?.outerHTML || (card.querySelector('.feat-num') ? `<div class="feat-num" style="width:48px;height:48px;font-size:20px;">${card.querySelector('.feat-num').textContent}</div>` : '');

    if (modal && modalBody) {
      modalBody.innerHTML = `
        <div class="modal-header-block">
          <div class="modal-header-icon">${iconHtml}</div>
          <div class="modal-title-wrap">
            <span class="popup-category" style="display:inline-block;margin-bottom:4px;font-weight:700;color:#2563eb;">${category}</span>
            <h3>${title}</h3>
            <p>${summary}</p>
          </div>
        </div>
        <div class="modal-notes-box">
          <h4>
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/></svg>
            Detailed Explanation Notes &amp; Capabilities
          </h4>
          <ul class="modal-notes-list">
            ${notesListHtml}
          </ul>
        </div>
        <div style="margin-bottom:20px;">
          <strong style="display:block;font-size:12px;color:#64748b;margin-bottom:8px;text-transform:uppercase;">System Compliance &amp; Standards:</strong>
          <div class="popup-pills-row">${pillsHtml}</div>
        </div>
        <div class="modal-footer-cta">
          <button class="btn btn-outline" type="button" onclick="document.getElementById('pillar-modal').hidden = true; document.body.style.overflow = '';">Close Window</button>
          <a class="btn btn-primary" href="#contact">Request Demo For This Module</a>
        </div>
      `;
      modal.hidden = false;
      document.body.style.overflow = 'hidden';
    }
  }

  interactiveCards.forEach((card) => {
    // When mouse hovers or drags across options
    card.addEventListener('mouseenter', () => {
      updatePillarPlacement(card);
      interactiveCards.forEach((c) => {
        if (c !== card) c.classList.remove('is-hovered');
      });
      card.classList.add('is-hovered');

      // Update and show real-time notification toast
      const title = card.querySelector('.popup-title')?.textContent || card.querySelector('h3, h4')?.textContent || 'Runwork Module';
      const category = card.querySelector('.popup-category')?.textContent || 'Enterprise Module';
      const summary = card.querySelector('.popup-summary')?.textContent || card.querySelector('p')?.textContent || '';
      
      if (toast && toastTitle && toastDesc) {
        clearTimeout(toastTimer);
        toastTitle.textContent = `${title} (${category})`;
        toastDesc.textContent = summary;
        toast.classList.add('is-visible');
      }
    });

    card.addEventListener('mouseleave', () => {
      card.classList.remove('is-hovered');
      if (toast) {
        clearTimeout(toastTimer);
        toastTimer = setTimeout(() => {
          // Only hide if no other card is currently hovered
          const anyHovered = document.querySelector('.pillar-card:hover, .pillar-card.is-hovered, .key-feat-card:hover, .key-feat-card.is-hovered');
          if (!anyHovered) {
            toast.classList.remove('is-visible');
          }
        }, 300);
      }
    });

    // Support dragging/moving mouse across grid
    card.addEventListener('mousemove', () => {
      if (!card.classList.contains('is-hovered')) {
        updatePillarPlacement(card);
        card.classList.add('is-hovered');
      }
    });

    // Click / Enter key opens full modal with detailed explanation notes
    card.addEventListener('click', (e) => {
      if (e.target.closest('a')) return;
      showInteractiveCardModal(card);
    });

    card.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        showInteractiveCardModal(card);
      }
    });
  });

  // Wire up the 4 phone screen hotspots in mobile view
  const phoneHotspots = document.querySelectorAll('.phone-tile-hotspot');
  phoneHotspots.forEach((hotspot) => {
    const featId = hotspot.dataset.appFeature;
    const targetCard = document.querySelector(`.key-feat-card[data-feature="${featId}"]`);

    hotspot.addEventListener('mouseenter', () => {
      if (targetCard) {
        updatePillarPlacement(targetCard);
        interactiveCards.forEach((c) => c.classList.remove('is-hovered'));
        targetCard.classList.add('is-hovered');

        const title = targetCard.querySelector('.popup-title')?.textContent || '';
        const category = targetCard.querySelector('.popup-category')?.textContent || '';
        const summary = targetCard.querySelector('.popup-summary')?.textContent || '';
        if (toast && toastTitle && toastDesc) {
          clearTimeout(toastTimer);
          toastTitle.textContent = `${title} (${category})`;
          toastDesc.textContent = summary;
          toast.classList.add('is-visible');
        }
      }
    });

    hotspot.addEventListener('mouseleave', () => {
      if (targetCard) targetCard.classList.remove('is-hovered');
    });

    hotspot.addEventListener('click', () => {
      if (featId === '2') {
        openLiveMessengerModal();
        return;
      }
      if (targetCard) {
        showInteractiveCardModal(targetCard);
      }
    });
  });

  // Close modal handlers
  const closeModal = () => {
    if (modal) {
      modal.hidden = true;
      document.body.style.overflow = '';
    }
  };

  if (modalClose) modalClose.addEventListener('click', closeModal);
  if (modalBackdrop) modalBackdrop.addEventListener('click', closeModal);
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && modal && !modal.hidden) {
      closeModal();
    }
  });

  // Pre-fill Looking For field when clicking "Apply Now" on job vacancies (delegated)
  document.addEventListener('click', (e) => {
    const applyBtn = e.target.closest('.vacancy-card .btn');
    if (applyBtn) {
      const card = applyBtn.closest('.vacancy-card');
      const jobTitle = card?.querySelector('h4')?.textContent?.trim();
      const lookingInput = document.getElementById('apply-looking');
      if (jobTitle && lookingInput) {
        lookingInput.value = `Application for ${jobTitle}`;
      }
    }
  });

  // Vacancies Slide Rolling Carousel
  const vacCarousel = document.getElementById('vacancies-carousel');
  if (vacCarousel) {
    const vacViewport = document.getElementById('vacancies-viewport');
    const vacTrack = document.getElementById('vacancies-track');
    const vacCards = vacTrack ? Array.from(vacTrack.querySelectorAll('.vacancy-card')) : [];
    const vacPrevBtn = document.getElementById('vac-prev-btn');
    const vacNextBtn = document.getElementById('vac-next-btn');
    const vacPlayToggle = document.getElementById('vac-play-toggle');
    const vacDotsContainer = document.getElementById('vac-dots');
    const vacProgressBar = document.getElementById('vac-progress-bar');
    const vacActiveIndexEl = document.getElementById('vac-active-index');

    let currentIndex = 0;
    let isPaused = false;
    let isHovered = false;
    let isDragging = false;
    let progress = 0;
    const rollDuration = 3600; // 3.6s per slide
    const tickMs = 50;
    const progressStep = 100 / (rollDuration / tickMs);

    function getVisibleCards() {
      if (window.innerWidth >= 1024) return 3;
      if (window.innerWidth >= 640) return 2;
      return 1;
    }

    function getMaxIndex() {
      return Math.max(0, vacCards.length - getVisibleCards());
    }

    function buildDots() {
      if (!vacDotsContainer) return;
      vacDotsContainer.innerHTML = '';
      const totalSteps = getMaxIndex() + 1;
      for (let i = 0; i < totalSteps; i++) {
        const dot = document.createElement('button');
        dot.type = 'button';
        dot.className = `vac-dot ${i === currentIndex ? 'active' : ''}`;
        dot.setAttribute('role', 'tab');
        dot.setAttribute('aria-label', `Go to opportunity slide ${i + 1}`);
        dot.setAttribute('aria-selected', i === currentIndex ? 'true' : 'false');
        dot.addEventListener('click', () => {
          currentIndex = i;
          progress = 0;
          updateSlide();
        });
        vacDotsContainer.appendChild(dot);
      }
    }

    function updateSlide(animate = true) {
      const maxIdx = getMaxIndex();
      if (currentIndex > maxIdx) currentIndex = maxIdx;
      if (currentIndex < 0) currentIndex = 0;

      if (vacCards.length > 0 && vacTrack) {
        const cardWidth = vacCards[0].offsetWidth;
        const gap = 20; // 20px CSS gap
        const offset = currentIndex * (cardWidth + gap);
        vacTrack.style.transition = animate ? 'transform 0.55s cubic-bezier(0.22, 1, 0.36, 1)' : 'none';
        vacTrack.style.transform = `translateX(-${offset}px)`;
      }

      if (vacActiveIndexEl) {
        vacActiveIndexEl.textContent = currentIndex + 1;
      }

      // Update dots
      if (vacDotsContainer) {
        const dots = vacDotsContainer.querySelectorAll('.vac-dot');
        dots.forEach((dot, idx) => {
          dot.classList.toggle('active', idx === currentIndex);
          dot.setAttribute('aria-selected', idx === currentIndex ? 'true' : 'false');
        });
      }

      // Reset progress bar on step change
      progress = 0;
      if (vacProgressBar) {
        vacProgressBar.style.width = '0%';
      }
    }

    // Auto-rolling ticker loop
    const rollTicker = setInterval(() => {
      if (isPaused || isHovered || isDragging) return;

      progress += progressStep;
      if (vacProgressBar) {
        vacProgressBar.style.width = `${Math.min(100, progress)}%`;
      }

      if (progress >= 100) {
        progress = 0;
        const maxIdx = getMaxIndex();
        currentIndex = (currentIndex >= maxIdx) ? 0 : currentIndex + 1;
        updateSlide(true);
      }
    }, tickMs);

    // Pause on hover
    vacCarousel.addEventListener('mouseenter', () => { isHovered = true; });
    vacCarousel.addEventListener('mouseleave', () => { isHovered = false; });

    // Controls: Prev / Next
    if (vacPrevBtn) {
      vacPrevBtn.addEventListener('click', () => {
        const maxIdx = getMaxIndex();
        currentIndex = currentIndex > 0 ? currentIndex - 1 : maxIdx;
        progress = 0;
        updateSlide(true);
      });
    }

    if (vacNextBtn) {
      vacNextBtn.addEventListener('click', () => {
        const maxIdx = getMaxIndex();
        currentIndex = currentIndex < maxIdx ? currentIndex + 1 : 0;
        progress = 0;
        updateSlide(true);
      });
    }

    // Controls: Play / Pause toggle
    if (vacPlayToggle) {
      vacPlayToggle.addEventListener('click', () => {
        isPaused = !isPaused;
        vacPlayToggle.classList.toggle('paused', isPaused);
        const iconPause = vacPlayToggle.querySelector('.icon-pause');
        const iconPlay = vacPlayToggle.querySelector('.icon-play');
        if (iconPause && iconPlay) {
          iconPause.style.display = isPaused ? 'none' : 'block';
          iconPlay.style.display = isPaused ? 'block' : 'none';
        }
        const label = isPaused ? 'Resume slide rolling' : 'Pause slide rolling';
        vacPlayToggle.setAttribute('title', label);
        vacPlayToggle.setAttribute('aria-label', label);
      });
    }

    // Keyboard navigation when viewport focused
    if (vacViewport) {
      vacViewport.addEventListener('keydown', (e) => {
        if (e.key === 'ArrowLeft') {
          e.preventDefault();
          const maxIdx = getMaxIndex();
          currentIndex = currentIndex > 0 ? currentIndex - 1 : maxIdx;
          progress = 0;
          updateSlide(true);
        } else if (e.key === 'ArrowRight') {
          e.preventDefault();
          const maxIdx = getMaxIndex();
          currentIndex = currentIndex < maxIdx ? currentIndex + 1 : 0;
          progress = 0;
          updateSlide(true);
        }
      });
    }

    // Touch & Pointer Drag
    let dragStartX = 0;
    let dragCurrentX = 0;

    if (vacViewport && vacTrack) {
      vacViewport.addEventListener('mousedown', (e) => {
        if (e.target.closest('a, button')) return;
        isDragging = true;
        dragStartX = e.clientX;
        dragCurrentX = e.clientX;
        vacTrack.classList.add('is-dragging');
      });

      window.addEventListener('mousemove', (e) => {
        if (!isDragging) return;
        dragCurrentX = e.clientX;
      });

      window.addEventListener('mouseup', () => {
        if (!isDragging) return;
        isDragging = false;
        vacTrack.classList.remove('is-dragging');
        const diff = dragCurrentX - dragStartX;
        if (diff > 45) {
          // Dragged right -> Previous slide
          const maxIdx = getMaxIndex();
          currentIndex = currentIndex > 0 ? currentIndex - 1 : maxIdx;
          progress = 0;
          updateSlide(true);
        } else if (diff < -45) {
          // Dragged left -> Next slide
          const maxIdx = getMaxIndex();
          currentIndex = currentIndex < maxIdx ? currentIndex + 1 : 0;
          progress = 0;
          updateSlide(true);
        }
      });

      // Mobile Touch events
      vacViewport.addEventListener('touchstart', (e) => {
        if (e.target.closest('a, button')) return;
        isDragging = true;
        dragStartX = e.touches[0].clientX;
        dragCurrentX = dragStartX;
      }, { passive: true });

      vacViewport.addEventListener('touchmove', (e) => {
        if (!isDragging) return;
        dragCurrentX = e.touches[0].clientX;
      }, { passive: true });

      vacViewport.addEventListener('touchend', () => {
        if (!isDragging) return;
        isDragging = false;
        const diff = dragCurrentX - dragStartX;
        if (diff > 40) {
          const maxIdx = getMaxIndex();
          currentIndex = currentIndex > 0 ? currentIndex - 1 : maxIdx;
          progress = 0;
          updateSlide(true);
        } else if (diff < -40) {
          const maxIdx = getMaxIndex();
          currentIndex = currentIndex < maxIdx ? currentIndex + 1 : 0;
          progress = 0;
          updateSlide(true);
        }
      });
    }

    // Handle Window Resize
    let resizeTimer;
    window.addEventListener('resize', () => {
      clearTimeout(resizeTimer);
      resizeTimer = setTimeout(() => {
        buildDots();
        updateSlide(false);
      }, 120);
    });

    // Initial setup
    buildDots();
    updateSlide(false);
  }

  // ==================== REAL-TIME INTERACTIVE LIVE MESSENGER ====================
  const liveMsgrModal = document.getElementById('live-messenger-modal');
  const liveMsgrBackdrop = document.getElementById('live-msgr-backdrop');
  const liveMsgrClose = document.getElementById('live-msgr-close');
  const liveMsgrSearchInput = document.getElementById('live-msgr-search-input');
  const liveMsgrContactsContainer = document.getElementById('live-msgr-contacts');
  const liveMsgrActiveHeader = document.getElementById('live-msgr-active-header');
  const liveMsgrMessagesLog = document.getElementById('live-msgr-messages-log');
  const liveMsgrTyping = document.getElementById('live-msgr-typing');
  const liveMsgrTypingText = document.getElementById('live-msgr-typing-text');
  const liveMsgrComposer = document.getElementById('live-msgr-composer');
  const liveMsgrInput = document.getElementById('live-msgr-input');

  const liveContacts = [
    {
      id: 'sarah',
      name: 'Sarah Jenkins',
      role: 'HR Operations Specialist',
      roleBadge: 'HR Ops',
      dept: 'People & Operations · Chennai HQ',
      status: 'Active on Runwork One',
      initials: 'SJ',
      history: [
        { sender: 'other', text: 'Hello! I am on desk duty today for employee onboarding, compliance documents, and attendance verification. How can I assist you?', time: '10:14 AM' }
      ]
    },
    {
      id: 'vikram',
      name: 'Vikram Malhotra',
      role: 'Warehouse Shift Supervisor',
      roleBadge: 'Shift Ops',
      dept: 'Logistics Hub · Bengaluru Unit',
      status: 'On-Floor Active',
      initials: 'VM',
      history: [
        { sender: 'other', text: 'Shift A floor supervision is active. Geo-fenced QR check-ins and overtime records are synced to the central board.', time: '10:20 AM' }
      ]
    },
    {
      id: 'priya',
      name: 'Priya Sharma',
      role: 'Senior Payroll & Compliance Officer',
      roleBadge: 'Finance Desk',
      dept: 'Corporate Payroll · Mumbai HQ',
      status: 'Online',
      initials: 'PS',
      history: [
        { sender: 'other', text: 'Monthly salary reconciliation is complete. Statutory deductions and itemized payslip worksheets are updated in your Digital Vault.', time: '09:45 AM' }
      ]
    },
    {
      id: 'rajesh',
      name: 'Rajesh Kumar',
      role: 'Operations Field Lead',
      roleBadge: 'Field Ops',
      dept: 'Workforce Operations · Pune Unit',
      status: 'On Duty',
      initials: 'RK',
      history: [
        { sender: 'other', text: 'Campus attendance geo-fence is verified across Chennai and Pune facilities. Let me know if you need shift reassignment.', time: '11:05 AM' }
      ]
    },
    {
      id: 'kavya',
      name: 'Kavya Nair',
      role: 'Central HR Administration',
      roleBadge: 'Central Admin',
      dept: 'Corporate HQ · Gurugram',
      status: 'Available',
      initials: 'KN',
      history: [
        { sender: 'other', text: 'Welcome to Runwork EWFS! I can assist with employee verification, statutory registers, and multi-branch team governance.', time: 'Yesterday' }
      ]
    }
  ];

  let activeContactId = 'sarah';

  const getActiveContact = () => liveContacts.find((c) => c.id === activeContactId) || liveContacts[0];

  const renderLiveContacts = (query = '') => {
    if (!liveMsgrContactsContainer) return;
    const q = query.trim().toLowerCase();
    const filtered = liveContacts.filter((c) =>
      !q ||
      c.name.toLowerCase().includes(q) ||
      c.role.toLowerCase().includes(q) ||
      c.roleBadge.toLowerCase().includes(q) ||
      c.dept.toLowerCase().includes(q)
    );

    if (filtered.length === 0) {
      liveMsgrContactsContainer.innerHTML = `
        <div style="padding:16px;text-align:center;font-size:12px;color:#94a3b8;">
          No contacts found matching "${query}".
        </div>
      `;
      return;
    }

    liveMsgrContactsContainer.innerHTML = filtered.map((c) => {
      const isActive = c.id === activeContactId;
      const lastMsg = c.history[c.history.length - 1];
      return `
        <button type="button" class="live-contact-btn ${isActive ? 'active' : ''}" data-contact-id="${c.id}">
          <div class="live-avatar">
            ${c.initials}
            <span class="live-online-dot"></span>
          </div>
          <div class="live-contact-info">
            <div class="live-contact-name">
              <span>${c.name}</span>
              <span class="live-contact-role">${c.roleBadge}</span>
            </div>
            <div class="live-contact-sub">${lastMsg ? lastMsg.text : c.dept}</div>
          </div>
        </button>
      `;
    }).join('');

    liveMsgrContactsContainer.querySelectorAll('.live-contact-btn').forEach((btn) => {
      btn.addEventListener('click', () => {
        activeContactId = btn.dataset.contactId;
        renderLiveContacts(liveMsgrSearchInput ? liveMsgrSearchInput.value : '');
        renderActiveChat();
      });
    });
  };

  const renderActiveChat = () => {
    const contact = getActiveContact();
    if (!contact) return;

    if (liveMsgrActiveHeader) {
      liveMsgrActiveHeader.innerHTML = `
        <div class="live-header-recipient">
          <div class="live-avatar">
            ${contact.initials}
            <span class="live-online-dot"></span>
          </div>
          <div>
            <div class="live-header-title">
              <span>${contact.name}</span>
              <span class="live-header-badge">${contact.roleBadge}</span>
            </div>
            <div class="live-header-meta">
              <span class="live-active-tag">Online</span> · <span>${contact.dept}</span> · <span style="color:#64748b;">${contact.status}</span>
            </div>
          </div>
        </div>
        <button type="button" id="live-header-msg-btn"
          style="background:#0284c7;color:white;border:none;border-radius:999px;padding:6px 14px;font-size:12px;font-weight:600;cursor:pointer;display:inline-flex;align-items:center;gap:4px;flex-shrink:0;">
          💬 Message
        </button>
      `;

      const headerMsgBtn = liveMsgrActiveHeader.querySelector('#live-header-msg-btn');
      if (headerMsgBtn) {
        headerMsgBtn.onclick = () => {
          if (liveMsgrInput) {
            liveMsgrInput.focus();
            liveMsgrInput.placeholder = `Message ${contact.name}...`;
          }
        };
      }
    }

    if (liveMsgrMessagesLog) {
      liveMsgrMessagesLog.innerHTML = `
        <div class="chat-date-pill">Today · Real-Time Encrypted Session</div>
        ${contact.history.map((msg) => {
          const isMine = msg.sender === 'mine';
          return `
            <div class="live-bubble ${isMine ? 'mine' : ''}">
              <small>
                <span>${isMine ? 'You' : contact.name} · ${isMine ? 'Verified User' : contact.roleBadge}</span>
                <span>${msg.time}${isMine ? '<span class="live-bubble-check">✓✓</span>' : ''}</span>
              </small>
              <div>${msg.text}</div>
            </div>
          `;
        }).join('')}
      `;
      liveMsgrMessagesLog.scrollTop = liveMsgrMessagesLog.scrollHeight;
    }
  };

  const generateLiveResponse = (contact, text) => {
    const lower = text.toLowerCase();
    const firstName = contact.name.split(' ')[0];

    if (lower.includes('hello') || lower.includes('hi') || lower.includes('hey')) {
      return `Hello! ${firstName} here. Great to connect on Runwork One. How can I help you today?`;
    }
    if (lower.includes('shift') || lower.includes('timing') || lower.includes('swap') || lower.includes('roster')) {
      return `Got your message regarding shift operations! The shift schedule for tomorrow is active on the Runwork EWFS board. Please complete your GPS punch-in upon arrival.`;
    }
    if (lower.includes('payslip') || lower.includes('salary') || lower.includes('pay') || lower.includes('bonus')) {
      return `Your itemized payslip has been reconciled by the corporate payroll desk and is ready for 1-click PDF download in your Digital Employee Vault.`;
    }
    if (lower.includes('leave') || lower.includes('holiday') || lower.includes('vacation')) {
      return `I have received your leave enquiry. The department coverage check is green, and the shift manager has been notified for one-touch approval.`;
    }
    if (lower.includes('doc') || lower.includes('vault') || lower.includes('aadhaar') || lower.includes('pan')) {
      return `Your document upload is encrypted with 256-bit bank-grade security. Statutory KYC verification is complete on your profile.`;
    }
    if (lower.includes('thank') || lower.includes('ok') || lower.includes('sure')) {
      return `You're welcome! Feel free to ping anytime on the Runwork Business Messenger. Have a great day!`;
    }
    return `Received: "${text}". I have logged this request on the ${contact.dept} desk and will follow up with you promptly.`;
  };

  const openLiveMessengerModal = () => {
    if (!liveMsgrModal) return;
    liveMsgrModal.hidden = false;
    document.body.style.overflow = 'hidden';
    renderLiveContacts();
    renderActiveChat();
    setTimeout(() => {
      if (liveMsgrInput) liveMsgrInput.focus();
    }, 150);
  };

  const closeLiveMessengerModal = () => {
    if (!liveMsgrModal) return;
    liveMsgrModal.hidden = true;
    document.body.style.overflow = '';
  };

  // Wire search input in live modal
  if (liveMsgrSearchInput) {
    liveMsgrSearchInput.addEventListener('input', (e) => {
      renderLiveContacts(e.target.value);
    });
  }

  // Wire close buttons
  if (liveMsgrClose) liveMsgrClose.addEventListener('click', closeLiveMessengerModal);
  if (liveMsgrBackdrop) liveMsgrBackdrop.addEventListener('click', closeLiveMessengerModal);

  // Wire all launch buttons across the landing page
  document.querySelectorAll('.launch-live-messenger-btn').forEach((btn) => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      openLiveMessengerModal();
    });
  });

  // Wire Quick chips in live modal
  document.querySelectorAll('.msgr-chip').forEach((chip) => {
    chip.addEventListener('click', () => {
      if (liveMsgrInput) {
        liveMsgrInput.value = chip.dataset.msg;
        liveMsgrInput.focus();
      }
    });
  });

  // Wire message submission
  if (liveMsgrComposer) {
    liveMsgrComposer.addEventListener('submit', (e) => {
      e.preventDefault();
      const text = (liveMsgrInput ? liveMsgrInput.value : '').trim();
      if (!text) return;
      if (liveMsgrInput) liveMsgrInput.value = '';

      const contact = getActiveContact();
      const nowTime = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

      // Add user's message
      contact.history.push({ sender: 'mine', text, time: nowTime });
      renderActiveChat();

      // Show typing indicator
      if (liveMsgrTyping && liveMsgrTypingText) {
        liveMsgrTypingText.textContent = `${contact.name} is typing...`;
        liveMsgrTyping.style.display = 'flex';
        if (liveMsgrMessagesLog) liveMsgrMessagesLog.scrollTop = liveMsgrMessagesLog.scrollHeight;
      }

      // Real-time reply simulation after 900ms
      setTimeout(() => {
        if (liveMsgrTyping) liveMsgrTyping.style.display = 'none';
        const replyText = generateLiveResponse(contact, text);
        const replyTime = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
        contact.history.push({ sender: 'other', text: replyText, time: replyTime });
        renderActiveChat();
        renderLiveContacts(liveMsgrSearchInput ? liveMsgrSearchInput.value : '');
      }, 900);
    });
  }

  // Handle escape key
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      if (liveMsgrModal && !liveMsgrModal.hidden) {
        closeLiveMessengerModal();
      }
    }
  });
});
