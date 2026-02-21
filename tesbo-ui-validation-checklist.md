# Tesbo UI/UX Validation Checklist

## Context
Comparing portal.tesbo.io (reference) vs local BetterCasesv3 implementation

**Reference URL**: https://portal.tesbo.io/runs/aabb4124-9c80-4085-9899-489221895785
**Local URL**: http://localhost:3000/projects/{projectId}/tesbo-reports/runs

---

## Expected Local Implementation (Based on Code Analysis)

### 1. RUNS LIST PAGE (`/tesbo-reports/runs`)

#### Information Architecture
- **Page Title**: "Tesbo Runs"
- **Subtitle**: "Run-level execution reporting from Tesbo Reports."
- **Back Link**: "Back to Tesbo Reports" → `/projects/{projectId}/tesbo-reports`

#### Top Section - Build Controls
- Section label: "BUILDS" (uppercase, tracked)
- Heading: "Build history"
- Description: "Filter by time, status, source, or search to find a run."
- **Action Buttons**:
  - "Upload build file" (blue, file picker for .json)
  - "Refresh" (gray)
  - "Ingest sample" (gray)

#### Search & Filters
- **Search Input**: "Search name, branch, PR, author, run #"
- **Time Range Filters**: Last 30 days / Last 7 days / All time (pill buttons)
- **Status Dropdown**: All status / Passed / Failed / Skipped
- **Source Dropdown**: All sources / PLAYWRIGHT / (others)
- **Results Counter**: "Showing X of Y filtered runs (Z total)"
- **Pagination Info**: "Page X / Y"

#### Table Structure
**Columns** (11 total):
1. Run # (e.g., "#123")
2. Name
3. Branch
4. PR
5. Commit author
6. GitHub build (githubRunId)
7. Status
8. Totals (colored badges: green passed, red failed, amber skipped)
9. Source (e.g., PLAYWRIGHT)
10. Started (timestamp)
11. Details ("Open" link)

**Row Behavior**: Entire row is clickable → navigates to run detail

#### Bottom Pagination
- "Showing X-Y of Z"
- "Prev" / "Next" buttons
- "Page X / Y"

---

### 2. RUN DETAIL PAGE (`/tesbo-reports/runs/{runId}`)

#### Header
- **Title**: Run name (e.g., run.name)
- **Subtitle**: `{status} · {sourceType} · {startedAt}`
- **Back Link**: "Back to Runs" → `/tesbo-reports/runs`

#### Summary Card (Stats)
- **4 Stat Boxes**: Total / Passed / Failed / Skipped
- **Action Buttons**:
  - "Create Share Link"
  - "Disable Share" (red)
- **Public URL Display**: Shows if sharing enabled

#### Filter/Search Section
- **Search Input**: "Search test, spec, error"
- **Status Filters**: ALL / Passed / Failed / Skipped (pill buttons)

#### Test Cases Display
**Grouped by Spec**:
- Collapsible spec sections
- Spec name header + count
- Each case shows:
  - Title (bold)
  - Status badge
  - Duration (e.g., "1.22s")
  - Attempt number if > 1
  - Error message preview (red box, line-clamped)

**Click behavior**: Opens modal drawer

#### Modal Drawer (Test Case Detail)
**Header**:
- Label: "TEST DETAILS" (uppercase)
- Title: Case title
- Spec name
- Navigation: Prev / Next / Close buttons

**Stats Grid** (4 boxes):
- Status
- Duration
- Attempt
- Browser

**Artifacts Section**:
- Label: "ARTIFACTS"
- Links: Trace / Screenshot / Video (if available)

**Failure Details Section**:
- Label: "FAILURE DETAILS" (red theme)
- Error message
- Stack trace (scrollable, pre-wrapped)

**Steps Section**:
- Label: "STEPS"
- Numbered steps with descriptions
- Fallback: "No steps captured for this test case."

---

## Validation Items to Check

### ✅ Portal.tesbo.io (Reference Site)

#### Authentication
- [ ] Login page appearance
- [ ] Email field label/placeholder
- [ ] Password field label/placeholder
- [ ] Login button text
- [ ] Post-login redirect behavior

#### Run Detail Page Structure
- [ ] URL pattern: `/runs/{runId}` or similar
- [ ] Page title/heading
- [ ] Breadcrumb navigation
- [ ] Back button location and text
- [ ] Run metadata displayed (status, time, source, etc.)
- [ ] Summary statistics layout
- [ ] Test case grouping (by spec or flat list?)
- [ ] Filter/search affordances
- [ ] Table vs card layout
- [ ] Color coding for pass/fail/skip
- [ ] Artifact links (trace, screenshot, video)
- [ ] Modal vs inline detail view
- [ ] URL changes when viewing test detail
- [ ] Navigation tabs (if any)
- [ ] Share/export features
- [ ] Settings/config options

---

### ✅ Localhost BetterCasesv3

#### Authentication
- [ ] OTP flow appearance
- [ ] Email field label
- [ ] OTP code field label
- [ ] OTP default value working (123456)
- [ ] Post-login redirect

#### Runs List Page
- [ ] Accessible at `/projects/{projectId}/tesbo-reports/runs`
- [ ] Page title: "Tesbo Runs"
- [ ] All 11 table columns present
- [ ] Search works with name/branch/PR/author/run#
- [ ] Time range filters work (30d/7d/all)
- [ ] Status filter works
- [ ] Source filter works
- [ ] Pagination works
- [ ] Row click navigates to detail
- [ ] Upload build file button works
- [ ] Ingest sample creates test data
- [ ] Colored badges for pass/fail/skip counts

#### Run Detail Page
- [ ] Accessible at `/projects/{projectId}/tesbo-reports/runs/{runId}`
- [ ] Page title shows run name
- [ ] Subtitle shows status · source · time
- [ ] Back to Runs link works
- [ ] 4 stat boxes display correctly
- [ ] Create Share Link button works
- [ ] Disable Share button works
- [ ] Public URL displays when sharing enabled
- [ ] Search box filters tests
- [ ] Status filter pills work
- [ ] Tests grouped by spec
- [ ] Spec sections collapsible
- [ ] Test case cards show all fields
- [ ] Error preview displays
- [ ] Click opens modal
- [ ] Modal shows complete test detail
- [ ] Prev/Next navigation in modal
- [ ] Artifacts section shows links
- [ ] Failure details section (red theme)
- [ ] Steps section shows numbered steps
- [ ] Close modal works

---

## Known Differences to Document

### Information Architecture
- [ ] Portal: URL routing pattern
- [ ] Local: `/projects/{projectId}/tesbo-reports/runs/{runId}`
- [ ] Portal: Breadcrumb structure
- [ ] Local: Simple "Back to Runs" link

### Data Fields
- [ ] Portal: Which metadata fields shown?
- [ ] Local: name, status, sourceType, branchName, pullRequest, commitAuthor, runNumber, githubRunId, startedAt, endedAt
- [ ] Missing fields in local?
- [ ] Extra fields in local?

### UI/UX Patterns
- [ ] Portal: Table vs cards for runs list?
- [ ] Local: Table with 11 columns
- [ ] Portal: Test detail view inline or modal?
- [ ] Local: Modal drawer overlay
- [ ] Portal: Collapsible spec groups?
- [ ] Local: Yes, collapsible by default open
- [ ] Portal: Color scheme (light/dark mode?)
- [ ] Local: Full dark mode support

### Features
- [ ] Portal: Share functionality?
- [ ] Local: Yes - create/disable share links
- [ ] Portal: Public sharing URLs?
- [ ] Local: Yes - generates public share tokens
- [ ] Portal: Upload build files?
- [ ] Local: Yes - JSON file upload
- [ ] Portal: Artifact links (trace/screenshot/video)?
- [ ] Local: Yes - all three types supported
- [ ] Portal: Step-level detail?
- [ ] Local: Yes - numbered steps in modal

### Missing/Broken Elements
- [ ] Placeholder text or "TODO" markers
- [ ] Broken image/icon references
- [ ] Non-functional buttons
- [ ] Missing error states
- [ ] Incomplete loading states

---

## Manual Testing Script

### For Portal.tesbo.io:
```
1. Open https://portal.tesbo.io/runs/aabb4124-9c80-4085-9899-489221895785
2. If redirected to login:
   - Enter: vir@qable.io
   - Password: QAble@1010
   - Note login page labels/layout
3. Wait for run details to load
4. Document:
   - All visible section headings
   - All metadata fields and their labels
   - All buttons and their text
   - Table/card structure
   - Navigation elements (breadcrumbs, back button, tabs)
   - Color scheme and status indicators
   - Any charts or visualizations
5. Try clicking into a test case (if possible)
6. Document the detail view structure
7. Note URL changes during navigation
8. Check for filters, sorting, search
9. Look for share/export features
10. Screenshot each unique view
```

### For Localhost:
```
1. Open http://localhost:3000/projects/4804a8b3-7c9c-4f2d-807f-c52ba1a2380f/tesbo-reports/runs
2. If redirected to login:
   - Enter: vir@qable.io
   - Enter OTP: 123456
3. Click "Ingest sample" to create test data (if no runs exist)
4. Verify runs list table displays
5. Click into a run to open detail page
6. Test all filters and search
7. Click into a test case to open modal
8. Test Prev/Next navigation in modal
9. Verify all sections render (stats, artifacts, failures, steps)
10. Test Create Share Link and verify URL generation
11. Screenshot each view matching portal screenshots
```

---

## Comparison Matrix Template

| Feature | Portal.tesbo.io | Localhost | Status | Notes |
|---------|----------------|-----------|--------|-------|
| **URL Pattern** | `/runs/{id}` ? | `/projects/{pid}/tesbo-reports/runs/{id}` | ❓ | |
| **Page Title** | ? | "Tesbo Runs" | ❓ | |
| **Runs List View** | ? | Table (11 cols) | ❓ | |
| **Run Detail View** | ? | Card with stats + grouped cases | ❓ | |
| **Test Detail View** | ? | Modal drawer | ❓ | |
| **Breadcrumbs** | ? | Simple back link | ❓ | |
| **Search** | ? | ✅ Full text search | ❓ | |
| **Filters - Status** | ? | ✅ All/Passed/Failed/Skipped | ❓ | |
| **Filters - Time** | ? | ✅ 30d/7d/all | ❓ | |
| **Filters - Source** | ? | ✅ Dropdown | ❓ | |
| **Pagination** | ? | ✅ Page-based | ❓ | |
| **Share Links** | ? | ✅ Create/disable | ❓ | |
| **Upload Build** | ? | ✅ JSON file | ❓ | |
| **Artifacts** | ? | ✅ Trace/Screenshot/Video | ❓ | |
| **Step Detail** | ? | ✅ Numbered steps | ❓ | |
| **Error Display** | ? | ✅ Message + stack trace | ❓ | |
| **Dark Mode** | ? | ✅ Full support | ❓ | |
| **Metadata Fields** | ? | name, status, source, branch, PR, author, run#, GitHub ID, timestamps | ❓ | |

---

## Next Steps

1. **Manual validation required**: Since browser automation is not currently working, this checklist should be used for manual side-by-side comparison
2. **Screenshot capture**: Take screenshots of both portal.tesbo.io and localhost at key states for visual diff
3. **Document gaps**: Fill in the "?" cells in the comparison matrix with actual observations
4. **Prioritize discrepancies**: Focus on critical UX/feature gaps first
5. **Update implementation**: Based on findings, update local code to match portal where needed

---

## Expected Deliverable Format

After manual validation, provide:

### 1. Information Architecture Differences
- Portal sections vs Local sections
- Navigation patterns
- URL routing differences

### 2. Data Field Differences
- Fields shown in Portal but missing in Local
- Fields in Local not in Portal
- Label/naming differences

### 3. Interaction Differences
- Different button behaviors
- Different filter/sort mechanisms
- Different detail view patterns

### 4. Visual Hierarchy Differences
- Layout differences (table vs cards vs list)
- Emphasis differences (what's prominent)
- Color coding differences

### 5. Missing/Broken Elements
- Features in Portal not in Local
- Placeholder/TODO items in Local
- Non-functional elements

### 6. Security/Access Differences
- Authentication flows
- Permission checks
- Session handling

### 7. Final Verdict
- Overall parity assessment
- Critical gaps to address
- Nice-to-have improvements
- Recommendation for next steps
