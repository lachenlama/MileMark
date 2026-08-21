// MileMark — the "happenings" around the run, shown as a one-at-a-time carousel.
// Self-contained + data-driven so anyone can update an event by editing the
// EVENTS array below. Each event carries a photo (in /images), a live "on now"
// status computed from its time windows, and a filter category. Renders the
// slides, wires the arrows/dots + filter chips. No backend needed.

(() => {
  // ---- the events. edit these freely. ----
  // cat:     morning | night | daily   (drives the filter chips)
  // windows: when it's actually on, for the "on now" badge.
  //          days = array of weekday numbers (0=sun … 6=sat), or "all".
  //          from/to are 24h hours.
  const EVENTS = [
    {
      id: "coffee-maailis", kicker: "fuel", name: "coffee by maailis pasal", img: "images/coffee.jpg",
      blurb: "the cup that's worth the climb back. freshly brewed and pulled slow — sit down, don't rush it.",
      meta: "all day · on the house once", cat: "daily", accent: "hap-coffee",
      windows: [{ days: "all", from: 8, to: 21 }],
    },
    {
      id: "ice-bath", kicker: "recovery", name: "the ice bath", img: "images/ice-bath.jpg",
      blurb: "two minutes you'll dread and then brag about. get in, breathe, come back human.",
      meta: "mornings · post-run dip", cat: "morning", accent: "hap-cold",
      windows: [{ days: [0, 6], from: 6, to: 11 }],
    },
    {
      id: "breakfast-milemark", kicker: "morning feast", name: "breakfast by milemark", img: "images/breakfast.jpg",
      blurb: "hot breakfast waiting at the table when the miles are done. eggs, fresh bakes, and runners sharing stories.",
      meta: "mornings · community table", cat: "morning", accent: "hap-breakfast",
      windows: [{ days: [0, 6], from: 7, to: 12 }],
    },
    {
      id: "dj-arox", kicker: "sound", name: "dj set by arox", img: "images/dj-set.jpg",
      blurb: "curated morning beats and after-run selections by AROX. good music and good volume.",
      meta: "sessions · live selections", cat: "night", accent: "hap-rave",
      windows: [{ days: [5, 6], from: 18, to: 23 }],
    },
    {
      id: "group-ice-bath", kicker: "community", name: "group & ice bath", img: "images/group-run.jpg",
      blurb: "lace up, shake the legs out, run together. no pace shaming, whoever shows up is family.",
      meta: "weekends · all levels", cat: "morning", accent: "hap-cali",
      windows: [{ days: [0, 6], from: 6, to: 10 }],
    },
  ];

  // ---- live status ----
  function isLive(ev, now = new Date()) {
    const day = now.getDay();
    const hour = now.getHours() + now.getMinutes() / 60;
    return (ev.windows || []).some((w) => {
      const dayOk = w.days === "all" || w.days.includes(day);
      return dayOk && hour >= w.from && hour < w.to;
    });
  }

  function statusFor(ev, now = new Date()) {
    if (isLive(ev, now)) return { live: true, label: "on now" };
    if (ev.cat === "daily") return { live: false, label: "daily" };
    if (ev.cat === "night") return { live: false, label: "after dark" };
    return { live: false, label: "weekend mornings" };
  }

  // ---- render ----
  function cardHTML(ev) {
    const s = statusFor(ev);
    const status = s.live
      ? `<span class="hap-status is-live"><i class="hap-dot"></i> on now</span>`
      : `<span class="hap-status">${s.label}</span>`;
    return `
      <article class="hap-card ${ev.accent}${ev.wide ? " hap-wide" : ""}"
               data-cat="${ev.cat}" data-live="${s.live}">
        <div class="hap-art">
          <img class="hap-img" src="${ev.img}" alt="${ev.name}" loading="lazy" decoding="async" />
        </div>
        <div class="hap-content">
          <div class="hap-top">
            <span class="hap-kicker">${ev.kicker}</span>
            ${status}
          </div>
          <h3>${ev.name}</h3>
          <p class="hap-blurb">${ev.blurb}</p>
          <span class="hap-meta">${ev.meta}</span>
        </div>
      </article>`;
  }

  let carouselBuilt = false;
  let autoTimer = null;
  const AUTO_MS = 6000; // how long each slide holds before it advances on its own

  // ---- carousel: one slide at a time, auto-advancing + swipeable ----
  function visibleCards() {
    const grid = document.getElementById("hapGrid");
    return grid ? [...grid.querySelectorAll(".hap-card")] : [];
  }

  function activeIndex() {
    const grid = document.getElementById("hapGrid");
    const cards = visibleCards();
    if (!grid || !cards.length) return 0;
    const center = grid.scrollLeft + grid.clientWidth / 2;
    let best = 0,
      bestDist = Infinity;
    cards.forEach((c, i) => {
      const cc = c.offsetLeft + c.offsetWidth / 2;
      const d = Math.abs(cc - center);
      if (d < bestDist) {
        bestDist = d;
        best = i;
      }
    });
    return best;
  }

  function scrollToCard(i) {
    const grid = document.getElementById("hapGrid");
    const cards = visibleCards();
    const card = cards[Math.max(0, Math.min(i, cards.length - 1))];
    if (!grid || !card) return;
    // scroll the track horizontally only — never tug the whole page to the carousel
    const target = card.offsetLeft - (grid.clientWidth - card.offsetWidth) / 2;
    grid.scrollTo({ left: target, behavior: "smooth" });
  }

  function updateCarousel() {
    const dotsEl = document.getElementById("hapDots");
    const prev = document.getElementById("hapPrev");
    const next = document.getElementById("hapNext");
    const cards = visibleCards();
    const idx = activeIndex();
    cards.forEach((c, i) => c.classList.toggle("is-current", i === idx));
    if (dotsEl) {
      [...dotsEl.children].forEach((d, i) => d.classList.toggle("is-active", i === idx));
    }
    if (prev) prev.disabled = idx <= 0;
    if (next) next.disabled = idx >= cards.length - 1;
  }

  function rebuildDots() {
    const dotsEl = document.getElementById("hapDots");
    if (!dotsEl) return;
    const cards = visibleCards();
    dotsEl.innerHTML = cards
      .map((_, i) => `<button class="hap-dot-btn" type="button" data-i="${i}" aria-label="go to slide ${i + 1}"></button>`)
      .join("");
    dotsEl.hidden = cards.length <= 1;
    updateCarousel();
  }

  // ---- auto-advance (keeps cycling; user input just resets the clock) ----
  function advance() {
    const cards = visibleCards();
    if (cards.length <= 1) return;
    scrollToCard((activeIndex() + 1) % cards.length); // loop back to the first
  }
  function stopAuto() {
    if (autoTimer) clearInterval(autoTimer);
    autoTimer = null;
  }
  function startAuto() {
    stopAuto();
    if (!document.hidden && visibleCards().length > 1) {
      autoTimer = setInterval(advance, AUTO_MS);
    }
  }
  // restart the timer after a manual move so it doesn't jump right after the user acts
  function nudge(i) {
    scrollToCard(i);
    startAuto();
  }

  function wireCarousel() {
    if (carouselBuilt) return;
    const grid = document.getElementById("hapGrid");
    const dotsEl = document.getElementById("hapDots");
    if (!grid) return;

    if (dotsEl) {
      dotsEl.addEventListener("click", (e) => {
        const b = e.target.closest(".hap-dot-btn");
        if (b) nudge(+b.dataset.i);
      });
    }

    // ---- Mobile Touch Gesture Swiping ----
    let touchStartX = 0;
    let touchStartY = 0;
    let touchStartScroll = 0;
    let touchStartTime = 0;
    let isTouchSwiping = false;
    let isScrollingVertical = false;

    grid.addEventListener(
      "touchstart",
      (e) => {
        if (e.touches.length !== 1) return;
        stopAuto();
        const t = e.touches[0];
        touchStartX = t.clientX;
        touchStartY = t.clientY;
        touchStartScroll = grid.scrollLeft;
        touchStartTime = Date.now();
        isTouchSwiping = false;
        isScrollingVertical = false;
      },
      { passive: true }
    );

    grid.addEventListener(
      "touchmove",
      (e) => {
        if (e.touches.length !== 1 || isScrollingVertical) return;
        const t = e.touches[0];
        const dx = touchStartX - t.clientX;
        const dy = touchStartY - t.clientY;

        // If predominantly vertical scroll, let normal page scrolling happen
        if (!isTouchSwiping && Math.abs(dy) > Math.abs(dx) && Math.abs(dy) > 7) {
          isScrollingVertical = true;
          return;
        }

        // Horizontal swipe gesture detected
        if (Math.abs(dx) > 6) {
          isTouchSwiping = true;
          grid.style.scrollSnapType = "none";
          grid.scrollLeft = touchStartScroll + dx;
        }
      },
      { passive: true }
    );

    const finishTouchSwipe = (e) => {
      if (isScrollingVertical) {
        startAuto();
        return;
      }
      grid.style.scrollSnapType = "x mandatory";
      if (isTouchSwiping) {
        const changedTouch = e.changedTouches ? e.changedTouches[0] : null;
        const dx = changedTouch ? touchStartX - changedTouch.clientX : 0;
        const dt = Math.max(1, Date.now() - touchStartTime);
        const velocity = Math.abs(dx) / dt;

        const currentIdx = activeIndex();
        const cards = visibleCards();

        // If fast flick or dragged > 35px, advance or go back
        if (Math.abs(dx) > 35 || velocity > 0.25) {
          if (dx > 0 && currentIdx < cards.length - 1) {
            scrollToCard(currentIdx + 1);
          } else if (dx < 0 && currentIdx > 0) {
            scrollToCard(currentIdx - 1);
          } else {
            scrollToCard(currentIdx);
          }
        } else {
          scrollToCard(currentIdx);
        }
      }
      isTouchSwiping = false;
      isScrollingVertical = false;
      startAuto();
    };

    grid.addEventListener("touchend", finishTouchSwipe, { passive: true });
    grid.addEventListener("touchcancel", finishTouchSwipe, { passive: true });

    // ---- Desktop Mouse Drag Swiping ----
    let isMouseDown = false;
    let mouseStartX = 0;
    let mouseStartScroll = 0;

    grid.addEventListener("mousedown", (e) => {
      isMouseDown = true;
      mouseStartX = e.pageX - grid.offsetLeft;
      mouseStartScroll = grid.scrollLeft;
      grid.style.cursor = "grabbing";
      grid.style.scrollSnapType = "none";
      stopAuto();
    });

    window.addEventListener("mousemove", (e) => {
      if (!isMouseDown) return;
      e.preventDefault();
      const x = e.pageX - grid.offsetLeft;
      const walk = (x - mouseStartX) * 1.25;
      grid.scrollLeft = mouseStartScroll - walk;
    });

    const endMouseDrag = () => {
      if (!isMouseDown) return;
      isMouseDown = false;
      grid.style.cursor = "";
      grid.style.scrollSnapType = "x mandatory";
      scrollToCard(activeIndex());
      startAuto();
    };

    window.addEventListener("mouseup", endMouseDrag);
    grid.addEventListener("mouseleave", endMouseDrag);

    let ticking = false;
    grid.addEventListener("scroll", () => {
      if (ticking) return;
      ticking = true;
      requestAnimationFrame(() => {
        ticking = false;
        updateCarousel();
      });
    });

    // Pause cycling when the tab is hidden; resume when it's back
    document.addEventListener("visibilitychange", () => (document.hidden ? stopAuto() : startAuto()));
    carouselBuilt = true;
  }

  function render() {
    const grid = document.getElementById("hapGrid");
    const countEl = document.getElementById("hapCount");
    if (!grid) return;

    // keep the reader's place across the 60s "on now" re-render
    const prevScroll = grid.scrollLeft;
    grid.innerHTML = EVENTS.map(cardHTML).join("");
    grid.scrollLeft = prevScroll;

    // live count for the social-proof line
    const liveNow = EVENTS.filter((e) => isLive(e)).length;
    if (countEl) {
      countEl.textContent = liveNow
        ? `${liveNow} happening right now`
        : `${EVENTS.length} things on around the run this week`;
    }

    wireCarousel();
    rebuildDots();
    startAuto();
  }

  document.addEventListener("DOMContentLoaded", render);
  // re-evaluate "on now" if the tab is left open across a window boundary
  setInterval(render, 60 * 1000);
})();
