# 🔍 Tesbo UI/UX Validation Toolkit

> **Goal**: Compare portal.tesbo.io run-report pages with localhost BetterCasesv3 implementation

---

## 🚀 Quick Start (5 minutes)

```bash
# 1. Install dependencies
npm install playwright && npx playwright install chromium

# 2. Ensure your local servers are running
# Backend: http://localhost:7000
# Frontend: http://localhost:3000

# 3. Run automated validation
node tesbo-validation-script.js

# 4. Review results
open tesbo-validation-report.md
open portal-tesbo-screenshot.png
open localhost-screenshot.png
```

**Done!** You now have a complete comparison report with screenshots.

---

## 📁 Files Overview

| File | What It Does |
|------|--------------|
| **tesbo-validation-script.js** | 🤖 Automates browser testing with Playwright |
| **VALIDATION-SETUP.md** | 📖 Complete setup & troubleshooting guide |
| **tesbo-ui-validation-checklist.md** | ✅ Manual testing checklist (if automation fails) |
| **DELIVERABLES-SUMMARY.md** | 📊 Explanation of deliverables & findings |
| **package-validation.json** | 📦 Node.js dependencies |
| **README-VALIDATION.md** | 📄 This file |

---

## 🎯 What Gets Validated

### Portal.tesbo.io (Reference)
- ✅ Login flow & authentication
- ✅ Run details page structure
- ✅ Navigation elements (breadcrumbs, tabs, back buttons)
- ✅ Data fields and labels
- ✅ Buttons and actions
- ✅ Filters and search
- ✅ Table/card layouts
- ✅ Test case detail views

### Localhost (Your Implementation)
- ✅ Runs list page (`/projects/{id}/tesbo-reports/runs`)
- ✅ Run detail page (`/projects/{id}/tesbo-reports/runs/{runId}`)
- ✅ Test case modal drawer
- ✅ All features from code analysis
- ✅ Screenshots at each level

### The Comparison
- 📊 Information architecture differences
- 📊 Data field differences
- 📊 Interaction patterns
- 📊 Navigation structure
- 📊 Visual hierarchy
- 📊 Missing/broken elements
- 📊 Parity gap analysis

---

## 🛠️ Three Ways to Validate

### Option 1: Automated (Fastest) ⚡
**Time**: 5-10 minutes  
**Effort**: Low  
**Detail**: High

```bash
node tesbo-validation-script.js
```

**Output**: Full report + screenshots + structured data

### Option 2: Manual (Most Thorough) 📝
**Time**: 30-45 minutes  
**Effort**: Medium  
**Detail**: Highest

```bash
open tesbo-ui-validation-checklist.md
```

Follow the step-by-step checklist to test every feature.

### Option 3: Quick Visual (Fastest) 👀
**Time**: 10-15 minutes  
**Effort**: Low  
**Detail**: Medium

1. Open portal.tesbo.io and localhost side-by-side
2. Login to both (credentials in VALIDATION-SETUP.md)
3. Navigate through matching flows
4. Take screenshots and compare

---

## 🔐 Credentials Needed

### Portal.tesbo.io
- **Email**: vir@qable.io
- **Password**: QAble@1010

### Localhost
- **Email**: vir@qable.io
- **OTP**: 123456 (dev default)

---

## 📊 Expected Outputs

After running validation, you'll have:

### 1. tesbo-validation-report.md
Complete markdown report with:
- URL routing comparison
- Navigation structure analysis
- Button/action inventory
- Data field comparison
- Filter/search differences
- Visual hierarchy analysis
- Raw JSON data for deep-dive

### 2. Screenshots
- `portal-tesbo-screenshot.png` - Portal run details
- `localhost-screenshot.png` - Local runs list
- `localhost-run-detail-screenshot.png` - Local run details
- `localhost-test-detail-screenshot.png` - Local test modal

### 3. Console Output
Structured summary of findings during execution

---

## ⚠️ Prerequisites

### Required
- ✅ Node.js 16+ installed
- ✅ Backend running at http://localhost:7000
- ✅ Frontend running at http://localhost:3000
- ✅ Internet access to portal.tesbo.io

### Optional (for automation)
- ✅ Playwright installed
- ✅ Chromium browser installed via Playwright

---

## 🐛 Troubleshooting

### "Cannot find module 'playwright'"
```bash
npm install playwright
npx playwright install chromium
```

### "Failed to capture portal data"
- Check portal.tesbo.io is accessible
- Verify credentials are correct
- Try updating login selectors in script

### "Failed to capture local data"
- Ensure backend is running: `curl http://localhost:7000/api/health`
- Ensure frontend is running: `curl http://localhost:3000`
- Check OTP code is `123456` (dev default)

### "No runs in localhost"
Click "Ingest sample" button in UI to create test data

---

## 🎓 Understanding the Results

### Information Architecture
Compares URL patterns, navigation structures, page hierarchies

**Example findings**:
- Portal uses `/runs/{id}`
- Local uses `/projects/{pid}/tesbo-reports/runs/{id}`
- Both have breadcrumb navigation but different structure

### Data Fields
Compares what information is displayed and how

**Example findings**:
- Both show: status, duration, pass/fail/skip counts
- Portal may have: additional CI/CD metadata
- Local has: branch, PR, commit author, GitHub run ID

### Interactions
Compares buttons, filters, search, navigation flows

**Example findings**:
- Both have status filters
- Local has time range filters (30d/7d/all)
- Local has "Upload build file" feature

### Visual Hierarchy
Compares layout, emphasis, color coding

**Example findings**:
- Portal uses table layout
- Local uses card-based layout with collapsible sections
- Both use red/green/amber for fail/pass/skip

---

## 📈 Next Steps After Validation

1. **Review the report**: `tesbo-validation-report.md`
2. **Compare screenshots**: Side-by-side visual analysis
3. **Identify gaps**: What's missing in local?
4. **Prioritize fixes**:
   - P0: Critical features missing
   - P1: Important UX differences
   - P2: Nice-to-have improvements
5. **Update implementation**: Close the gaps
6. **Re-validate**: Run script again to confirm

---

## 💡 Pro Tips

### Get More Detail
Add more selectors in the script's `capturePortalData()` and `captureLocalData()` functions

### Test Different Runs
Change `PORTAL_URL` and `LOCAL_URL` constants in the script

### Compare Multiple Runs
Run script multiple times with different URLs, rename output files between runs

### Debug Issues
Set `headless: false` in script to watch browser automation live

### Extend Validation
Add custom comparison logic in the `compareData()` function

---

## 📞 Need Help?

1. **Setup issues**: Read `VALIDATION-SETUP.md`
2. **Manual testing**: Follow `tesbo-ui-validation-checklist.md`
3. **Understanding results**: Check `DELIVERABLES-SUMMARY.md`
4. **Script errors**: Add `console.log()` statements for debugging
5. **Questions**: Review all documentation files

---

## ✨ Summary

This toolkit gives you **three ways** to validate UI/UX parity:

1. **Automated script** - Fastest, most efficient
2. **Manual checklist** - Most thorough, detailed
3. **Visual comparison** - Quick, good for final verification

**Choose based on your needs:**
- Need detailed data? → Automated
- Want to test interactions? → Manual
- Quick gut-check? → Visual

All paths lead to understanding the differences between portal.tesbo.io and your local implementation.

---

## 🚀 Ready?

```bash
# Let's go!
node tesbo-validation-script.js
```

Good luck! 🎉
