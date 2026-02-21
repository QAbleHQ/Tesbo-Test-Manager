# Tesbo UI/UX Validation - Setup & Execution Guide

## Overview
This guide helps you validate UI/UX differences between:
- **Portal (reference)**: https://portal.tesbo.io/runs/aabb4124-9c80-4085-9899-489221895785
- **Local (implementation)**: http://localhost:3000/projects/.../tesbo-reports/runs

## Files Created
1. `tesbo-validation-script.js` - Automated Playwright script
2. `package-validation.json` - Node.js dependencies
3. `tesbo-ui-validation-checklist.md` - Manual validation checklist
4. `VALIDATION-SETUP.md` - This file

---

## Option 1: Automated Validation (Recommended)

### Prerequisites
- Node.js 16+ installed
- Local server running at http://localhost:3000
- Portal.tesbo.io accessible

### Setup Steps

1. **Install dependencies**:
   ```bash
   cd /Users/lifetools/BetterCasesv3
   npm install --package-lock-only playwright
   npx playwright install chromium
   ```

2. **Ensure local server is running**:
   ```bash
   # In another terminal, start your local server
   cd frontend
   npm run dev
   ```

3. **Run validation script**:
   ```bash
   node tesbo-validation-script.js
   ```

### What the Script Does

1. **Opens portal.tesbo.io**
   - Navigates to the run details page
   - Attempts login if needed (email: vir@qable.io, password: QAble@1010)
   - Captures:
     - All headings (H1-H4)
     - All buttons and their states
     - Navigation elements (breadcrumbs, tabs)
     - Table headers
     - Input fields and placeholders
     - Select dropdowns and options
     - Status badges
   - Takes full-page screenshot (`portal-tesbo-screenshot.png`)

2. **Opens localhost**
   - Navigates to runs page
   - Attempts OTP login if needed (email: vir@qable.io, OTP: 123456)
   - Captures same data points as portal
   - Takes screenshot (`localhost-screenshot.png`)
   - Clicks into first run (if available)
   - Takes run detail screenshot (`localhost-run-detail-screenshot.png`)
   - Clicks into first test case (if available)
   - Takes test detail screenshot (`localhost-test-detail-screenshot.png`)

3. **Generates comparison report**
   - Creates `tesbo-validation-report.md` with:
     - URL routing differences
     - Navigation structure differences
     - Button/action differences
     - Data field differences
     - Visual hierarchy differences
     - Screenshots references
     - Raw JSON data for deep analysis

### Expected Output

After successful execution:
```
=== PORTAL.TESBO.IO ===
Current URL: ...
Screenshot saved: portal-tesbo-screenshot.png

=== LOCALHOST ===
Current URL: ...
Screenshot saved: localhost-screenshot.png
Clicking into first run...
Screenshot saved: localhost-run-detail-screenshot.png

=== COMPARISON ===
Report saved: tesbo-validation-report.md

✅ Validation complete!
📄 Report: tesbo-validation-report.md
📸 Screenshots: portal-tesbo-screenshot.png, localhost-screenshot.png
```

---

## Option 2: Manual Validation

If automated script fails or you prefer manual validation:

1. **Open the checklist**:
   ```bash
   open tesbo-ui-validation-checklist.md
   ```

2. **Follow manual testing script**:
   - Section: "Manual Testing Script"
   - Test portal.tesbo.io first
   - Test localhost second
   - Document findings in the comparison matrix

3. **Key areas to compare**:
   - [ ] URL routing patterns
   - [ ] Page titles and headings
   - [ ] Navigation (breadcrumbs, back buttons, tabs)
   - [ ] Table structure and columns
   - [ ] Filters (time range, status, source)
   - [ ] Search functionality
   - [ ] Buttons and actions
   - [ ] Run detail page layout
   - [ ] Test case detail view (modal vs inline)
   - [ ] Artifacts section (trace, screenshot, video)
   - [ ] Error display format
   - [ ] Share link functionality
   - [ ] Upload build file feature
   - [ ] Pagination controls
   - [ ] Color coding for pass/fail/skip

---

## Option 3: Quick Manual Check

If you just need a quick visual comparison:

### Portal.tesbo.io
1. Open: https://portal.tesbo.io/runs/aabb4124-9c80-4085-9899-489221895785
2. Login: vir@qable.io / QAble@1010
3. Take screenshots of:
   - Run details page
   - Any test case detail view
   - Navigation structure

### Localhost
1. Open: http://localhost:3000/projects/4804a8b3-7c9c-4f2d-807f-c52ba1a2380f/tesbo-reports/runs
2. Login: vir@qable.io / OTP: 123456
3. Click "Ingest sample" to create test data (if needed)
4. Take screenshots of:
   - Runs list page
   - Run details page (click into a run)
   - Test case detail modal (click into a test)
5. Compare side-by-side

---

## Troubleshooting

### Script fails to login to portal
- Check credentials are still valid
- Update `PORTAL_EMAIL` and `PORTAL_PASSWORD` in script
- Portal may have changed their login form selectors

### Script fails to login to localhost
- Ensure backend is running and OTP service works
- Check if OTP code `123456` is still the dev default
- Update `LOCAL_OTP` in script if needed

### Browser doesn't launch
- Run: `npx playwright install chromium`
- Check Node.js version: `node --version` (needs 16+)

### Screenshots are blank
- Increase `waitForTimeout` values in script
- Add more explicit waits for content loading

### No runs in localhost
- Click "Ingest sample" button to create test data
- Or upload a build file
- Or use backend API to create runs

### Network errors
- Ensure portal.tesbo.io is accessible
- Check local backend is running on port 7000
- Check local frontend is running on port 3000

---

## Customization

### Change target URLs
Edit these constants in `tesbo-validation-script.js`:

```javascript
const PORTAL_URL = 'https://portal.tesbo.io/runs/YOUR-RUN-ID';
const LOCAL_URL = 'http://localhost:3000/projects/YOUR-PROJECT-ID/tesbo-reports/runs';
```

### Change credentials
```javascript
const PORTAL_EMAIL = 'your-email@example.com';
const PORTAL_PASSWORD = 'your-password';
const LOCAL_EMAIL = 'your-email@example.com';
const LOCAL_OTP = 'your-otp-code';
```

### Add more selectors
In `capturePortalData()` and `captureLocalData()` functions, add:

```javascript
// Example: Capture all links
links: await page.$$eval('a', els => els.map(el => ({
  text: el.textContent.trim(),
  href: el.href
}))),
```

### Change screenshot settings
```javascript
await page.screenshot({ 
  path: 'screenshot.png', 
  fullPage: true,  // Change to false for viewport only
  type: 'png'      // or 'jpeg'
});
```

---

## Next Steps After Validation

1. **Review generated report**: `tesbo-validation-report.md`
2. **Compare screenshots** side-by-side
3. **Identify critical gaps**:
   - Missing features in local
   - Different UX patterns
   - Broken/incomplete elements
4. **Prioritize fixes**:
   - P0: Critical features missing
   - P1: UX differences that impact usability
   - P2: Nice-to-have improvements
5. **Update local implementation** based on findings
6. **Re-run validation** to confirm fixes

---

## Support

If you encounter issues:
1. Check the troubleshooting section above
2. Review the manual checklist for alternative validation
3. Examine the generated report JSON for detailed data
4. Compare screenshots visually if script data is incomplete

---

## Summary

**Automated**: Run `node tesbo-validation-script.js` → Get report + screenshots
**Manual**: Follow `tesbo-ui-validation-checklist.md` → Document findings
**Quick**: Open both URLs → Take screenshots → Visual comparison
