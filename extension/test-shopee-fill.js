/**
 * Quick test script for Shopee form filling.
 *
 * Usage:
 *   1. Open https://seller.shopee.tw/portal/product/new in Chrome
 *   2. Open DevTools console (F12)
 *   3. Paste this entire script and press Enter
 *
 * This bypasses the full pipeline (FB scrape → AI → fill) and directly
 * tests the Shopee form filling with mock data.
 */

(async function testShopeeFill() {
  'use strict';

  // ─── Helpers ───────────────────────────────────────────────────────
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  function setCharByChar(el, value) {
    const setter = Object.getOwnPropertyDescriptor(
      Object.getPrototypeOf(el), 'value'
    )?.set;
    const set = setter ? (v) => setter.call(el, v) : (v) => { el.value = v; };
    el.focus();
    set('');
    el.dispatchEvent(new Event('input', { bubbles: true }));
    for (const ch of value) {
      set(el.value + ch);
      el.dispatchEvent(new Event('input', { bubbles: true }));
    }
    el.dispatchEvent(new Event('change', { bubbles: true }));
  }

  function setNative(el, value) {
    const setter = Object.getOwnPropertyDescriptor(
      Object.getPrototypeOf(el), 'value'
    )?.set;
    if (setter) setter.call(el, value);
    else el.value = value;
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    el.dispatchEvent(new Event('blur', { bubbles: true }));
  }

  function emitEnter(input) {
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 13, bubbles: true }));
    input.dispatchEvent(new KeyboardEvent('keypress', { key: 'Enter', code: 'Enter', keyCode: 13, bubbles: true }));
    input.dispatchEvent(new KeyboardEvent('keyup', { key: 'Enter', code: 'Enter', keyCode: 13, bubbles: true }));
  }

  // ─── Config: Choose test mode ──────────────────────────────────────
  // Set this to 'single' for no-variation or 'multi' for with-variations
  const TEST_MODE = 'multi'; // ← Change this to 'single' to test without specs

  const log = (msg) => console.log(`%c[test] ${msg}`, 'color: #0ea5e9; font-weight: bold');
  const err = (msg) => console.error(`[test] ❌ ${msg}`);
  const ok = (msg) => console.log(`%c[test] ✅ ${msg}`, 'color: #22c55e; font-weight: bold');

  // ─── Step 1: Category ──────────────────────────────────────────────
  log('Step 1: Selecting category...');

  const categoryBox = document.querySelector('.product-category-box');
  if (categoryBox) {
    categoryBox.click();
    await sleep(600);

    // Navigate: 居家生活 → 居家裝飾 → 窗簾、門簾
    const steps = ['居家生活', '居家裝飾', '窗簾、門簾'];
    const modalRoot = document.querySelector('.product-category-selector-modal') || document;

    for (const step of steps) {
      await sleep(300);
      const items = Array.from(modalRoot.querySelectorAll('.category-item'));
      const match = items.find(item => {
        const p = item.querySelector('p');
        return (p?.textContent || item.textContent || '').trim() === step;
      });
      if (match) {
        match.click();
        log(`  clicked "${step}"`);
        await sleep(400);
      } else {
        err(`  "${step}" not found`);
      }
    }

    // Click confirm — .eds-modal and .product-category-selector-modal are the SAME element.
    // The confirm button is INSIDE it: .product-category-selector-modal .eds-modal__footer-buttons .eds-button--primary
    // IMPORTANT: Do NOT use document.querySelector('.eds-modal__footer-buttons') — that matches
    // other hidden modals' footers first (e.g. the "儲存" modal), not the category modal.
    await sleep(200);
    const catModal = document.querySelector('.product-category-selector-modal');
    const confirmBtn = catModal?.querySelector('.eds-modal__footer-buttons .eds-button--primary');
    if (confirmBtn) {
      confirmBtn.click();
      ok('Category confirmed');
    } else {
      // Fallback: find any visible 確認 button
      const allBtns = Array.from(document.querySelectorAll('button.eds-button--primary'));
      const visibleConfirm = allBtns.find(b => b.textContent.trim() === '確認' && b.offsetParent !== null);
      if (visibleConfirm) {
        visibleConfirm.click();
        ok('Category confirmed (fallback)');
      } else {
        err('Category confirm button not found!');
      }
    }
    await sleep(2000); // Wait longer for Shopee to load sales info after category confirm
  } else {
    log('Category box not found — may already be selected');
  }

  // Verify modal is closed
  const modalStillOpen = document.querySelector('.product-category-selector-modal');
  if (modalStillOpen) {
    err('Category modal still open! Trying to force-close...');
    const forceBtn = modalStillOpen.querySelector('.eds-modal__footer-buttons .eds-button--primary');
    if (forceBtn) { forceBtn.click(); ok('Force-closed modal'); await sleep(1500); }
  }

  // ─── Step 2: Product name ──────────────────────────────────────────
  log('Step 2: Filling product name...');
  const nameInput = document.querySelector('input[placeholder*="品牌名稱"], input[placeholder*="商品類型"]');
  if (nameInput) {
    setNative(nameInput, '【測試商品】貓咪造型暖暖坐墊 冬季必備');
    ok('Name filled');
  } else {
    err('Name input not found');
  }

  // ─── Step 3: Description ───────────────────────────────────────────
  log('Step 3: Filling description...');
  const editor = document.querySelector('.ql-editor[contenteditable="true"]');
  if (editor) {
    editor.focus();
    editor.innerHTML = '';
    editor.textContent = '🐱 超可愛貓咪造型坐墊\n✨ 柔軟舒適，冬天暖暖坐\n📏 尺寸：約45x45cm\n🧵 材質：超柔短毛絨\n📦 重量：約500g\n\n⚠️ 此為測試商品，請勿下單';
    editor.dispatchEvent(new Event('input', { bubbles: true }));
    ok('Description filled');
  } else {
    err('Description editor not found');
  }

  // ─── Step 4: Sales info (price / specs) ────────────────────────────
  if (TEST_MODE === 'single') {
    // ───── Single product (no variations) ─────
    log('Step 4: Filling standalone price & stock (single mode)...');

    // Find price input — it's inside .price-input with NT$ prefix
    const priceInputs = Array.from(document.querySelectorAll('.price-input input, input.eds-input__input'));
    // Find the one near "價格" label
    const salesSection = document.querySelector('.product-sales-info-content, .no-variations');
    if (salesSection) {
      const pInput = salesSection.querySelector('.price-input input')
        || salesSection.querySelector('.basic-price input');
      if (pInput) {
        setCharByChar(pInput, '399');
        ok('Price filled: 399');
      } else {
        err('Price input not found in sales section');
      }

      // Stock
      const stockSection = salesSection.querySelector('.basic-stock');
      const sInput = stockSection?.querySelector('input');
      if (sInput) {
        setCharByChar(sInput, '99');
        ok('Stock filled: 99');
      } else {
        err('Stock input not found');
      }
    } else {
      err('Sales section not found');
    }

  } else {
    // ───── Multi-variant (with specifications) ─────
    log('Step 4: Opening spec section and adding variants...');

    // Click "+ 開啟商品規格"
    const openSpecBtns = Array.from(document.querySelectorAll('button'));
    const openSpec = openSpecBtns.find(b => b.textContent.includes('開啟商品規格'));
    if (openSpec) {
      openSpec.click();
      ok('Clicked 開啟商品規格');
      // Wait for spec section to render (Vue async)
      let tierReady = false;
      for (let attempt = 1; attempt <= 8; attempt++) {
        await sleep(attempt <= 2 ? 400 : 600);
        if (document.querySelector('input[placeholder*="例如: 顏色"], input[placeholder*="輸入選項"]')) {
          tierReady = true;
          log(`  Tier inputs appeared after attempt ${attempt}`);
          break;
        }
        log(`  Waiting for tier inputs (${attempt}/8)...`);
      }
      if (!tierReady) err('Tier name inputs never appeared after opening spec section');
    } else {
      err('開啟商品規格 button not found');
    }

    // Fill tier name: "款式"
    const tierNameInput = document.querySelector('input[placeholder*="例如: 顏色"]');
    if (tierNameInput) {
      tierNameInput.focus();
      setCharByChar(tierNameInput, '款式');
      ok('Tier name filled: 款式');
      await sleep(400);
    } else {
      err('Tier name input not found');
    }

    // Fill options: A款, B款, C款
    const options = ['經典黑貓', '灰色虎斑', '橘色小貓'];
    for (const opt of options) {
      // Find the empty option input (placeholder="輸入")
      const allOptionInputs = Array.from(document.querySelectorAll('input[placeholder="輸入"]'))
        .filter(inp => inp.offsetParent !== null && inp.type !== 'file' && !inp.value.trim());
      const optInput = allOptionInputs[allOptionInputs.length - 1];
      if (optInput) {
        optInput.focus();
        setCharByChar(optInput, opt);
        await sleep(100);
        emitEnter(optInput);
        ok(`Option added: ${opt}`);
        await sleep(300);
      } else {
        err(`Option input not found for "${opt}"`);
      }
    }

    await sleep(800); // Wait for spec table to render

    // Fill prices using batch apply
    log('Step 5: Filling prices via batch apply...');
    const batchRow = document.querySelector('.batch-edit-row');
    if (batchRow) {
      const batchPriceInput = batchRow.querySelector('.price-input input');
      const batchStockInput = Array.from(batchRow.querySelectorAll('input'))
        .find(inp => inp.placeholder === '商品數量');

      if (batchPriceInput) {
        setCharByChar(batchPriceInput, '399');
        ok('Batch price filled: 399');
      }
      if (batchStockInput) {
        setCharByChar(batchStockInput, '99');
        ok('Batch stock filled: 99');
      }

      await sleep(300);

      // Click "全部套用"
      const applyBtn = batchRow.querySelector('.batch-apply-button');
      if (applyBtn) {
        applyBtn.click();
        ok('全部套用 clicked!');
        await sleep(500);
      } else {
        err('全部套用 button not found');
      }
    } else {
      err('Batch edit row not found — spec table may not have rendered');

      // Fallback: try to find individual price inputs
      log('Trying individual price inputs...');
      const table = document.querySelector('.variation-model-table');
      if (table) {
        const priceInputs = Array.from(table.querySelectorAll('.price-input input'));
        for (let i = 0; i < priceInputs.length; i++) {
          setCharByChar(priceInputs[i], '399');
          ok(`Variant ${i + 1} price: 399`);
        }
      }
    }
  }

  // ─── Done ──────────────────────────────────────────────────────────
  console.log('\n');
  ok('🎉 Test complete! Check the form above.');
  log(`Mode: ${TEST_MODE} | Change TEST_MODE at line 70 to switch`);
})();
