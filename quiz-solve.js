#!/usr/bin/env node
//
// Generic SCORM (Articulate Rise) quiz solver.
// Extracts correct answers from React fiber: correctField for single-choice,
// correctsField for multi-choice. Ignores per-answer markedCorrect (decoy).
//
const puppeteer = require('puppeteer-core');
const CDP_URL = 'http://localhost:9222';

async function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function getScormFrame(page) {
  return page.frames().find(f => f.url().includes('scormcontent')) || null;
}

// Get state of the active quiz card
async function getActiveCardData(frame) {
  return frame.evaluate(() => {
    const active = document.querySelector('.quiz-card--active');
    if (!active) {
      const text = document.body.innerText;
      const buttons = [...document.querySelectorAll('button')]
        .filter(b => b.offsetParent !== null && !b.disabled)
        .map(b => b.innerText.trim()).filter(Boolean);
      // Check for the start quiz button (the ">" arrow)
      const startQuiz = document.querySelector('.quiz-header__start-quiz');
      const hasStartQuiz = startQuiz && startQuiz.offsetParent !== null;
      return { type: 'no-card', text: text.substring(0, 2000), buttons, hasStartQuiz };
    }

    // Check if already answered
    const feedbackLabel = active.querySelector('.quiz-card__feedback-label')?.innerText?.trim() || '';
    if (feedbackLabel === 'Correct' || feedbackLabel === 'Incorrect') {
      return { type: 'answered', feedbackLabel };
    }

    // Walk React fiber to get item data
    const fiberKey = Object.keys(active).find(k => k.startsWith('__reactFiber'));
    if (!fiberKey) return { type: 'error', msg: 'No React fiber' };

    let fiber = active[fiberKey];
    let itemData = null;
    for (let i = 0; i < 30 && fiber; i++) {
      const props = fiber.memoizedProps || fiber.pendingProps;
      if (props && props.item && props.item.answers) {
        itemData = props.item;
        break;
      }
      fiber = fiber.return;
    }
    if (!itemData) return { type: 'error', msg: 'No item data' };

    function strip(html) {
      return html.replace(/<[^>]+>/g, '').replace(/&nbsp;/g, ' ').trim();
    }

    const isMulti = itemData.type === 'MULTIPLE_RESPONSE';

    // Determine correct answer IDs:
    // Single choice: use correctField (item.correct)
    // Multi choice: use correctsField (item.corrects)
    const correctIds = new Set();
    if (isMulti && itemData.corrects) {
      itemData.corrects.forEach(id => correctIds.add(id));
    } else if (itemData.correct) {
      correctIds.add(itemData.correct);
    }

    const answers = itemData.answers.map(a => ({
      id: a.id,
      text: strip(a.title),
      isCorrect: correctIds.has(a.id),
    }));

    // Get the displayed option order from the DOM
    const radioGroup = active.querySelector('[role="radiogroup"]');
    const displayedTexts = radioGroup
      ? [...radioGroup.querySelectorAll('[data-test-id="quiz-mc-option-text"]')]
          .map(el => el.innerText.trim())
      : [...active.querySelectorAll('li')]
          .map(li => li.innerText.trim())
          .filter(Boolean);

    // Map displayed order to correct/incorrect
    const displayedOptions = displayedTexts.map((text, i) => {
      const match = answers.find(a => a.text === text);
      return { index: i, text, isCorrect: match ? match.isCorrect : false };
    });

    return {
      type: 'question',
      counter: active.querySelector('.quiz-card__counter')?.innerText?.trim() || '',
      question: strip(itemData.title),
      isMulti,
      displayedOptions,
    };
  });
}

// Select radio by display index
async function selectRadioByIndex(frame, index) {
  return frame.evaluate((idx) => {
    const active = document.querySelector('.quiz-card--active');
    if (!active) return false;
    const options = active.querySelectorAll('[data-test-id="quiz-card-option"]');
    if (idx >= options.length) return false;
    const radio = options[idx].querySelector('input[type="radio"]');
    if (radio) { radio.click(); return true; }
    return false;
  }, index);
}

// Select checkboxes by display indices
async function selectCheckboxesByIndices(frame, indices) {
  return frame.evaluate((idxs) => {
    const active = document.querySelector('.quiz-card--active');
    if (!active) return 0;
    const lis = [...active.querySelectorAll('li')];
    let count = 0;
    for (const idx of idxs) {
      if (idx < lis.length) {
        const cb = lis[idx].querySelector('input[type="checkbox"]');
        if (cb && !cb.checked) { cb.click(); count++; }
      }
    }
    return count;
  }, indices);
}

async function submitActive(frame) {
  return frame.evaluate(() => {
    const active = document.querySelector('.quiz-card--active');
    if (!active) return false;
    const btn = active.querySelector('button.quiz-card__button:not(.quiz-card__button--next)');
    if (btn) { btn.click(); return true; }
    return false;
  });
}

async function nextActive(frame) {
  return frame.evaluate(() => {
    const active = document.querySelector('.quiz-card--active');
    if (!active) return false;
    const btn = active.querySelector('.quiz-card__button--next');
    if (btn) { btn.click(); return true; }
    return false;
  });
}

async function clickNav(frame, text) {
  return frame.evaluate((t) => {
    for (const b of document.querySelectorAll('button')) {
      if (b.innerText.trim() === t && b.offsetParent !== null && !b.disabled) { b.click(); return true; }
    }
    return false;
  }, text);
}

async function main() {
  const browser = await puppeteer.connect({ browserURL: CDP_URL });
  const pages = await browser.pages();
  const page = pages.find(p => p.url().includes('3shapeacademy'));
  if (!page) { console.log('No 3Shape Academy tab found.'); process.exit(1); }

  console.log('Connected:', page.url());
  await sleep(1000);

  const frame = await getScormFrame(page);
  if (!frame) { console.log('No SCORM frame.'); process.exit(1); }
  console.log('Found SCORM frame\n');

  let correctCount = 0, totalCount = 0;

  for (let step = 0; step < 60; step++) {
    await sleep(2000);

    let card;
    try { card = await getActiveCardData(frame); } catch (e) {
      console.log(`Step ${step + 1}: frame error, retrying...`);
      continue;
    }

    console.log(`\n--- Step ${step + 1} ---`);

    if (card.type === 'no-card') {
      console.log(`  No active card. Buttons: [${card.buttons.join(', ')}]`);

      // Try to click the start quiz ">" button
      if (card.hasStartQuiz) {
        await frame.evaluate(() => {
          document.querySelector('.quiz-header__start-quiz').click();
        });
        console.log('  -> Started quiz (clicked >)');
        continue;
      }

      // Try standard navigation buttons
      for (const nav of ['NEXT', 'CONTINUE', 'START', 'FINISH', 'COMPLETE']) {
        if (card.buttons.includes(nav)) {
          await clickNav(frame, nav);
          console.log(`  -> ${nav}`);
          break;
        }
      }
      if (card.text.includes('100% COMPLETE') || card.text.includes('Passed')) {
        console.log(`\n=== COURSE COMPLETE! ${correctCount}/${totalCount} correct ===`);
        break;
      }
      continue;
    }

    if (card.type === 'answered') {
      if (card.feedbackLabel === 'Correct') correctCount++;
      totalCount++;
      console.log(`  ${card.feedbackLabel} (${correctCount}/${totalCount}). NEXT...`);
      await nextActive(frame);
      continue;
    }

    if (card.type === 'error') {
      console.log(`  Error: ${card.msg}`);
      break;
    }

    // Active question
    console.log(`  ${card.counter} [${card.isMulti ? 'multi' : 'single'}]: ${card.question.substring(0, 100)}`);
    card.displayedOptions.forEach(o =>
      console.log(`    ${o.isCorrect ? '->' : '  '} ${o.index + 1}. ${o.text.substring(0, 80)}`)
    );

    const correctIndices = card.displayedOptions.filter(o => o.isCorrect).map(o => o.index);
    if (correctIndices.length === 0) {
      console.log('  No correct answer identified. Stopping.');
      break;
    }

    if (card.isMulti) {
      const n = await selectCheckboxesByIndices(frame, correctIndices);
      console.log(`  Selected ${n} checkboxes`);
    } else {
      const ok = await selectRadioByIndex(frame, correctIndices[0]);
      console.log(`  Selected option #${correctIndices[0] + 1}: ${ok}`);
    }

    await sleep(500);
    await submitActive(frame);
    console.log('  Submitted');
  }

  console.log('\nDone.');
  browser.disconnect();
}

main().catch(err => { console.error('Error:', err.message); process.exit(1); });
