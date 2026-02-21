/**
 * Tesbo UI/UX Validation Script
 * 
 * This script uses Playwright to automate the comparison of:
 * 1. https://portal.tesbo.io/runs/... (reference)
 * 2. http://localhost:3000/projects/.../tesbo-reports/runs (local)
 * 
 * Prerequisites:
 *   npm install playwright
 *   npx playwright install chromium
 * 
 * Usage:
 *   node tesbo-validation-script.js
 */

const { chromium } = require('playwright');
const fs = require('fs');

const PORTAL_URL = 'https://portal.tesbo.io/runs/aabb4124-9c80-4085-9899-489221895785';
const PORTAL_EMAIL = 'vir@qable.io';
const PORTAL_PASSWORD = 'QAble@1010';

const LOCAL_URL = 'http://localhost:3000/projects/4804a8b3-7c9c-4f2d-807f-c52ba1a2380f/tesbo-reports/runs';
const LOCAL_EMAIL = 'vir@qable.io';
const LOCAL_OTP = '123456';

async function capturePortalData(page) {
  console.log('\n=== PORTAL.TESBO.IO ===\n');
  
  await page.goto(PORTAL_URL);
  await page.waitForTimeout(2000);

  // Check if login is required
  const currentUrl = page.url();
  console.log('Current URL:', currentUrl);

  if (currentUrl.includes('login') || currentUrl.includes('auth')) {
    console.log('Login required, attempting login...');
    
    // Try to find and fill login form
    try {
      await page.fill('input[type="email"], input[name="email"]', PORTAL_EMAIL);
      await page.fill('input[type="password"], input[name="password"]', PORTAL_PASSWORD);
      await page.click('button[type="submit"], button:has-text("Login"), button:has-text("Sign in")');
      await page.waitForTimeout(3000);
    } catch (e) {
      console.error('Login failed:', e.message);
      return null;
    }
  }

  // Wait for content to load
  await page.waitForTimeout(3000);
  
  // Capture page structure
  const data = {
    url: page.url(),
    title: await page.title(),
    
    // Main content
    headings: await page.$$eval('h1, h2, h3, h4', els => els.map(el => ({
      tag: el.tagName,
      text: el.textContent.trim()
    }))),
    
    // Buttons and actions
    buttons: await page.$$eval('button, a[role="button"]', els => els.map(el => ({
      text: el.textContent.trim(),
      disabled: el.disabled || el.hasAttribute('disabled')
    }))).catch(() => []),
    
    // Navigation
    breadcrumbs: await page.$$eval('nav a, [aria-label="breadcrumb"] a', els => els.map(el => el.textContent.trim())).catch(() => []),
    
    // Tabs
    tabs: await page.$$eval('[role="tab"], .tab, button[data-tab]', els => els.map(el => ({
      text: el.textContent.trim(),
      active: el.classList.contains('active') || el.getAttribute('aria-selected') === 'true'
    }))).catch(() => []),
    
    // Metadata/labels (looking for key-value pairs)
    labels: await page.$$eval('label, .label, [class*="Label"]', els => els.map(el => el.textContent.trim())).catch(() => []),
    
    // Status badges
    badges: await page.$$eval('.badge, [class*="badge"], [class*="status"]', els => els.map(el => ({
      text: el.textContent.trim(),
      class: el.className
    }))).catch(() => []),
    
    // Tables
    tableHeaders: await page.$$eval('th', els => els.map(el => el.textContent.trim())).catch(() => []),
    
    // Forms/inputs
    inputs: await page.$$eval('input:not([type="hidden"])', els => els.map(el => ({
      type: el.type,
      placeholder: el.placeholder,
      name: el.name
    }))).catch(() => []),
    
    // Select dropdowns
    selects: await page.$$eval('select', els => els.map(el => ({
      name: el.name,
      options: Array.from(el.options).map(opt => opt.text)
    }))).catch(() => []),
  };

  // Take screenshot
  await page.screenshot({ path: 'portal-tesbo-screenshot.png', fullPage: true });
  console.log('Screenshot saved: portal-tesbo-screenshot.png');

  return data;
}

async function captureLocalData(page) {
  console.log('\n=== LOCALHOST ===\n');
  
  await page.goto(LOCAL_URL);
  await page.waitForTimeout(2000);

  // Check if login is required
  const currentUrl = page.url();
  console.log('Current URL:', currentUrl);

  if (!currentUrl.includes('tesbo-reports')) {
    console.log('Login required, attempting OTP login...');
    
    try {
      // Fill email
      await page.fill('input[type="email"], input[name="email"]', LOCAL_EMAIL);
      await page.click('button:has-text("Send"), button:has-text("Continue"), button[type="submit"]');
      await page.waitForTimeout(2000);
      
      // Fill OTP
      await page.fill('input[type="text"], input[name="code"], input[placeholder*="code" i]', LOCAL_OTP);
      await page.click('button:has-text("Verify"), button:has-text("Continue"), button[type="submit"]');
      await page.waitForTimeout(3000);
      
      // Navigate to runs page
      await page.goto(LOCAL_URL);
      await page.waitForTimeout(2000);
    } catch (e) {
      console.error('Login failed:', e.message);
      return null;
    }
  }

  // Wait for content to load
  await page.waitForTimeout(3000);
  
  // Capture page structure
  const data = {
    url: page.url(),
    title: await page.title(),
    
    // Main content
    headings: await page.$$eval('h1, h2, h3, h4', els => els.map(el => ({
      tag: el.tagName,
      text: el.textContent.trim()
    }))),
    
    // Buttons and actions
    buttons: await page.$$eval('button, a[role="button"]', els => els.map(el => ({
      text: el.textContent.trim(),
      disabled: el.disabled || el.hasAttribute('disabled')
    }))).catch(() => []),
    
    // Navigation
    breadcrumbs: await page.$$eval('nav a, [aria-label="breadcrumb"] a', els => els.map(el => el.textContent.trim())).catch(() => []),
    
    // Tabs
    tabs: await page.$$eval('[role="tab"], .tab, button[data-tab]', els => els.map(el => ({
      text: el.textContent.trim(),
      active: el.classList.contains('active') || el.getAttribute('aria-selected') === 'true'
    }))).catch(() => []),
    
    // Metadata/labels
    labels: await page.$$eval('label, .label, [class*="Label"]', els => els.map(el => el.textContent.trim())).catch(() => []),
    
    // Status badges
    badges: await page.$$eval('.badge, [class*="badge"], [class*="status"]', els => els.map(el => ({
      text: el.textContent.trim(),
      class: el.className
    }))).catch(() => []),
    
    // Tables
    tableHeaders: await page.$$eval('th', els => els.map(el => el.textContent.trim())).catch(() => []),
    
    // Forms/inputs
    inputs: await page.$$eval('input:not([type="hidden"])', els => els.map(el => ({
      type: el.type,
      placeholder: el.placeholder,
      name: el.name
    }))).catch(() => []),
    
    // Select dropdowns
    selects: await page.$$eval('select', els => els.map(el => ({
      name: el.name,
      options: Array.from(el.options).map(opt => opt.text)
    }))).catch(() => []),
  };

  // Take screenshot
  await page.screenshot({ path: 'localhost-screenshot.png', fullPage: true });
  console.log('Screenshot saved: localhost-screenshot.png');

  // Try clicking into a run if table exists
  try {
    const hasTable = await page.$('table tbody tr');
    if (hasTable) {
      console.log('\nClicking into first run...');
      await page.click('table tbody tr:first-child');
      await page.waitForTimeout(3000);
      
      // Capture run detail page
      data.runDetailUrl = page.url();
      data.runDetailHeadings = await page.$$eval('h1, h2, h3, h4', els => els.map(el => ({
        tag: el.tagName,
        text: el.textContent.trim()
      })));
      data.runDetailButtons = await page.$$eval('button', els => els.map(el => el.textContent.trim()));
      
      await page.screenshot({ path: 'localhost-run-detail-screenshot.png', fullPage: true });
      console.log('Screenshot saved: localhost-run-detail-screenshot.png');
      
      // Try clicking into a test case
      const hasTestCase = await page.$('[class*="case"], [role="button"]:has-text("test")');
      if (hasTestCase) {
        console.log('\nClicking into first test case...');
        await page.click('[class*="case"]:first-child, [role="button"]:first-child');
        await page.waitForTimeout(2000);
        
        data.testDetailVisible = await page.$('[class*="modal"], [class*="drawer"]') !== null;
        
        await page.screenshot({ path: 'localhost-test-detail-screenshot.png', fullPage: true });
        console.log('Screenshot saved: localhost-test-detail-screenshot.png');
      }
    }
  } catch (e) {
    console.log('Could not navigate to run/test details:', e.message);
  }

  return data;
}

function compareData(portalData, localData) {
  console.log('\n=== COMPARISON ===\n');
  
  const comparison = {
    urls: {
      portal: portalData.url,
      local: localData.url,
      patternDiff: 'Portal uses /runs/{id}, Local uses /projects/{pid}/tesbo-reports/runs'
    },
    
    headings: {
      portal: portalData.headings,
      local: localData.headings,
      diff: []
    },
    
    buttons: {
      portalCount: portalData.buttons.length,
      localCount: localData.buttons.length,
      portalButtons: portalData.buttons.map(b => b.text).filter(Boolean),
      localButtons: localData.buttons.map(b => b.text).filter(Boolean),
      missingInLocal: [],
      extraInLocal: []
    },
    
    navigation: {
      portalBreadcrumbs: portalData.breadcrumbs,
      localBreadcrumbs: localData.breadcrumbs,
      diff: portalData.breadcrumbs.length !== localData.breadcrumbs.length ? 'Different breadcrumb structure' : 'Similar'
    },
    
    tabs: {
      portal: portalData.tabs,
      local: localData.tabs,
      diff: portalData.tabs.length !== localData.tabs.length ? 'Different tab count' : 'Similar'
    },
    
    tables: {
      portalHeaders: portalData.tableHeaders,
      localHeaders: localData.tableHeaders,
      portalColumns: portalData.tableHeaders.length,
      localColumns: localData.tableHeaders.length
    },
    
    inputs: {
      portalInputs: portalData.inputs,
      localInputs: localData.inputs,
      placeholderDiff: []
    },
    
    filters: {
      portalSelects: portalData.selects,
      localSelects: localData.selects
    }
  };
  
  // Calculate button differences
  const portalButtonSet = new Set(comparison.buttons.portalButtons);
  const localButtonSet = new Set(comparison.buttons.localButtons);
  
  comparison.buttons.missingInLocal = comparison.buttons.portalButtons.filter(b => !localButtonSet.has(b));
  comparison.buttons.extraInLocal = comparison.buttons.localButtons.filter(b => !portalButtonSet.has(b));
  
  // Calculate heading differences
  const portalHeadingTexts = portalData.headings.map(h => h.text);
  const localHeadingTexts = localData.headings.map(h => h.text);
  comparison.headings.diff = {
    missingInLocal: portalHeadingTexts.filter(h => !localHeadingTexts.includes(h)),
    extraInLocal: localHeadingTexts.filter(h => !portalHeadingTexts.includes(h))
  };
  
  // Calculate input placeholder differences
  portalData.inputs.forEach(pInput => {
    const localMatch = localData.inputs.find(lInput => lInput.type === pInput.type);
    if (localMatch && pInput.placeholder !== localMatch.placeholder) {
      comparison.inputs.placeholderDiff.push({
        type: pInput.type,
        portal: pInput.placeholder,
        local: localMatch.placeholder
      });
    }
  });
  
  return comparison;
}

async function generateReport(portalData, localData, comparison) {
  const report = `
# Tesbo UI/UX Validation Report
Generated: ${new Date().toISOString()}

## Summary

**Portal URL**: ${comparison.urls.portal}
**Local URL**: ${comparison.urls.local}

---

## 1. Information Architecture Differences

### URL Routing
- **Portal**: ${comparison.urls.portal}
- **Local**: ${comparison.urls.local}
- **Analysis**: ${comparison.urls.patternDiff}

### Breadcrumbs/Navigation
- **Portal**: ${comparison.navigation.portalBreadcrumbs.length} items - ${JSON.stringify(comparison.navigation.portalBreadcrumbs)}
- **Local**: ${comparison.navigation.localBreadcrumbs.length} items - ${JSON.stringify(comparison.navigation.localBreadcrumbs)}
- **Difference**: ${comparison.navigation.diff}

### Tabs
- **Portal**: ${comparison.tabs.portal.length} tabs
  ${comparison.tabs.portal.map(t => `  - ${t.text}${t.active ? ' (active)' : ''}`).join('\n')}
- **Local**: ${comparison.tabs.local.length} tabs
  ${comparison.tabs.local.map(t => `  - ${t.text}${t.active ? ' (active)' : ''}`).join('\n')}

### Page Headings
**Portal**:
${comparison.headings.portal.map(h => `- ${h.tag}: ${h.text}`).join('\n')}

**Local**:
${comparison.headings.local.map(h => `- ${h.tag}: ${h.text}`).join('\n')}

**Missing in Local**: ${JSON.stringify(comparison.headings.diff.missingInLocal)}
**Extra in Local**: ${JSON.stringify(comparison.headings.diff.extraInLocal)}

---

## 2. Data Field Differences

### Table Columns
- **Portal**: ${comparison.tables.portalColumns} columns
  ${comparison.tables.portalHeaders.map(h => `  - ${h}`).join('\n')}
- **Local**: ${comparison.tables.localColumns} columns
  ${comparison.tables.localHeaders.map(h => `  - ${h}`).join('\n')}

### Search/Filter Inputs
**Portal Inputs**:
${portalData.inputs.map(i => `- ${i.type}: "${i.placeholder}"`).join('\n')}

**Local Inputs**:
${localData.inputs.map(i => `- ${i.type}: "${i.placeholder}"`).join('\n')}

**Placeholder Differences**:
${comparison.inputs.placeholderDiff.map(d => `- ${d.type}: Portal="${d.portal}" vs Local="${d.local}"`).join('\n')}

### Filter Dropdowns
**Portal**:
${comparison.filters.portalSelects.map(s => `- ${s.name}: ${s.options.join(', ')}`).join('\n')}

**Local**:
${comparison.filters.localSelects.map(s => `- ${s.name}: ${s.options.join(', ')}`).join('\n')}

---

## 3. Interaction Differences

### Buttons/Actions
- **Portal**: ${comparison.buttons.portalCount} buttons
- **Local**: ${comparison.buttons.localCount} buttons

**Portal Buttons**: ${comparison.buttons.portalButtons.join(', ')}

**Local Buttons**: ${comparison.buttons.localButtons.join(', ')}

**Missing in Local**: ${comparison.buttons.missingInLocal.length > 0 ? comparison.buttons.missingInLocal.join(', ') : 'None'}

**Extra in Local**: ${comparison.buttons.extraInLocal.length > 0 ? comparison.buttons.extraInLocal.join(', ') : 'None'}

---

## 4. Visual Hierarchy Differences

### Status Badges
**Portal**:
${portalData.badges.map(b => `- ${b.text} (${b.class})`).join('\n')}

**Local**:
${localData.badges.map(b => `- ${b.text} (${b.class})`).join('\n')}

---

## 5. Screenshots

See attached screenshots:
- portal-tesbo-screenshot.png
- localhost-screenshot.png
- localhost-run-detail-screenshot.png (if available)
- localhost-test-detail-screenshot.png (if available)

---

## 6. Final Verdict

### Parity Assessment
- **URL Routing**: ${comparison.urls.patternDiff}
- **Navigation**: ${comparison.navigation.diff}
- **Table Structure**: ${comparison.tables.portalColumns === comparison.tables.localColumns ? 'Match' : 'Different'}
- **Buttons**: ${comparison.buttons.missingInLocal.length} missing, ${comparison.buttons.extraInLocal.length} extra
- **Headings**: ${comparison.headings.diff.missingInLocal.length} missing, ${comparison.headings.diff.extraInLocal.length} extra

### Critical Gaps
${comparison.buttons.missingInLocal.length > 0 ? `- Missing buttons: ${comparison.buttons.missingInLocal.join(', ')}` : '- No critical button gaps'}
${comparison.headings.diff.missingInLocal.length > 0 ? `- Missing sections: ${comparison.headings.diff.missingInLocal.join(', ')}` : '- No critical section gaps'}

### Recommendations
1. Review URL routing patterns for consistency
2. Verify all critical actions are present
3. Ensure data fields match portal requirements
4. Test navigation flows end-to-end
5. Compare visual styling and color schemes

---

## Raw Data

<details>
<summary>Portal Data (JSON)</summary>

\`\`\`json
${JSON.stringify(portalData, null, 2)}
\`\`\`

</details>

<details>
<summary>Local Data (JSON)</summary>

\`\`\`json
${JSON.stringify(localData, null, 2)}
\`\`\`

</details>

<details>
<summary>Comparison Data (JSON)</summary>

\`\`\`json
${JSON.stringify(comparison, null, 2)}
\`\`\`

</details>
`;

  fs.writeFileSync('tesbo-validation-report.md', report);
  console.log('\nReport saved: tesbo-validation-report.md');
}

async function main() {
  const browser = await chromium.launch({ headless: false });
  const context = await browser.newContext({
    viewport: { width: 1920, height: 1080 }
  });
  
  try {
    // Capture portal data
    const portalPage = await context.newPage();
    const portalData = await capturePortalData(portalPage);
    await portalPage.close();
    
    if (!portalData) {
      console.error('Failed to capture portal data');
      await browser.close();
      return;
    }
    
    // Capture local data
    const localPage = await context.newPage();
    const localData = await captureLocalData(localPage);
    await localPage.close();
    
    if (!localData) {
      console.error('Failed to capture local data');
      await browser.close();
      return;
    }
    
    // Compare and generate report
    const comparison = compareData(portalData, localData);
    await generateReport(portalData, localData, comparison);
    
    console.log('\n✅ Validation complete!');
    console.log('📄 Report: tesbo-validation-report.md');
    console.log('📸 Screenshots: portal-tesbo-screenshot.png, localhost-screenshot.png');
    
  } catch (error) {
    console.error('Error during validation:', error);
  } finally {
    await browser.close();
  }
}

main();
