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
      id: "ice-bath", kicker: "recovery", name: "the ice bath", img: "images/ice-bath.jpg",
      blurb: "two minutes you'll dread and then brag about. get in, breathe, come back human.",
      meta: "mornings · by the cafe", cat: "morning", accent: "hap-cold",
      windows: [{ days: [0, 6], from: 6, to: 11 }],
    },
    {
      id: "calisthenics", kicker: "throwdown", name: "calisthenics comp", img: "images/calisthenics.jpg",
      blurb: "no machines, just your own weight and a crowd counting reps. whoever's left standing.",
      meta: "weekends · all levels", cat: "morning", accent: "hap-cali",
      windows: [{ days: [0, 6], from: 8, to: 12 }],
    },
    {
      id: "samas-coffee", kicker: "fuel", name: "sama's coffee", img: "images/coffee.jpg",
      blurb: "the cup that's worth the climb back. sama pulls them slow — sit down, don't rush it.",
      meta: "all day · on the house once", cat: "daily", accent: "hap-coffee",
      windows: [{ days: "all", from: 8, to: 21 }],
    },
    {
      id: "playstations", kicker: "downtime", name: "playstations & games", img: "images/playstations.jpg",
      blurb: "legs are done, so sink into a controller. couch, a cup, talking trash over a screen.",
      meta: "all day · winner keeps the seat", cat: "daily", accent: "hap-play",
      windows: [{ days: "all", from: 11, to: 22 }],
    },
    {
      id: "coffee-rave", kicker: "after dark", name: "coffee rave · djs", img: "images/coffee-rave.jpg",
      blurb: "when the cups go quiet, the speakers don't. local djs, low light, no list at the door.",
      meta: "nights · djs rotating", cat: "night", accent: "hap-rave", wide: true,
      windows: [{ days: [5, 6], from: 19, to: 24 }],
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
    const prev = document.getElementById("hapPrev");
    const next = document.getElementById("hapNext");
    if (!grid) return;

    if (prev) prev.addEventListener("click", () => nudge(activeIndex() - 1));
    if (next) next.addEventListener("click", () => nudge(activeIndex() + 1));
    if (dotsEl)
      dotsEl.addEventListener("click", (e) => {
        const b = e.target.closest(".hap-dot-btn");
        if (b) nudge(+b.dataset.i);
      });

    // a manual swipe/drag should also reset the auto-advance clock
    grid.addEventListener("pointerdown", startAuto, { passive: true });

    let ticking = false;
    grid.addEventListener("scroll", () => {
      if (ticking) return;
      ticking = true;
      requestAnimationFrame(() => {
        ticking = false;
        updateCarousel();
      });
    });

    // pause cycling when the tab is hidden; resume when it's back
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
