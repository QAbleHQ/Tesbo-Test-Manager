
# Tesbo UI/UX Validation Report
Generated: 2026-02-21T08:05:40.220Z

## Summary

**Portal URL**: https://portal.tesbo.io/projects
**Local URL**: http://localhost:3000/projects/4804a8b3-7c9c-4f2d-807f-c52ba1a2380f/tesbo-reports/runs

---

## 1. Information Architecture Differences

### URL Routing
- **Portal**: https://portal.tesbo.io/projects
- **Local**: http://localhost:3000/projects/4804a8b3-7c9c-4f2d-807f-c52ba1a2380f/tesbo-reports/runs
- **Analysis**: Portal uses /runs/{id}, Local uses /projects/{pid}/tesbo-reports/runs

### Breadcrumbs/Navigation
- **Portal**: 1 items - ["Home"]
- **Local**: 19 items - ["Home","Dashboard","Project","Test Generation","Generation History","Knowledge Base","Test case Repository","Test Plan","Test Run","Bugs","Test Reports","Activity","Overview","Runs","Specs","Tests","Analytics","Project settings","Workspace settings"]
- **Difference**: Different breadcrumb structure

### Tabs
- **Portal**: 0 tabs
  
- **Local**: 0 tabs
  

### Page Headings
**Portal**:
- H2: Project catalogue

**Local**:
- H1: Tesbo Runs
- H2: Build history

**Missing in Local**: ["Project catalogue"]
**Extra in Local**: ["Tesbo Runs","Build history"]

---

## 2. Data Field Differences

### Table Columns
- **Portal**: 0 columns
  
- **Local**: 11 columns
    - Run #
  - Name
  - Branch
  - PR
  - Commit author
  - GitHub build
  - Status
  - Totals
  - Source
  - Started
  - Details

### Search/Filter Inputs
**Portal Inputs**:


**Local Inputs**:
- file: ""
- text: "Search name, branch, PR, author, run #"

**Placeholder Differences**:


### Filter Dropdowns
**Portal**:


**Local**:
- : All status, Passed, Failed, Skipped
- : All sources

---

## 3. Interaction Differences

### Buttons/Actions
- **Portal**: 20 buttons
- **Local**: 9 buttons

**Portal Buttons**: Toggle theme, Logout, New project, Refresh data, API fvfgzv••••sp, API jsywrk••••sp, API fitkbt••••fj, API bofuab••••ix, API pqyfpc••••yy, API yfechs••••ib, API xyjkdj••••jx, API ibhfss••••dc, API ycgnpy••••ch, API lmuetm••••ed, API bqicmn••••va, API jzoazl••••xc, API ydqofi••••kk, API xgygne••••xq, API mcaoxr••••lh

**Local Buttons**: Upload build file, Refresh, Ingest sample, Last 30 days, Last 7 days, All time, Prev, Next

**Missing in Local**: Toggle theme, Logout, New project, Refresh data, API fvfgzv••••sp, API jsywrk••••sp, API fitkbt••••fj, API bofuab••••ix, API pqyfpc••••yy, API yfechs••••ib, API xyjkdj••••jx, API ibhfss••••dc, API ycgnpy••••ch, API lmuetm••••ed, API bqicmn••••va, API jzoazl••••xc, API ydqofi••••kk, API xgygne••••xq, API mcaoxr••••lh

**Extra in Local**: Upload build file, Refresh, Ingest sample, Last 30 days, Last 7 days, All time, Prev, Next

---

## 4. Visual Hierarchy Differences

### Status Badges
**Portal**:


**Local**:


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
- **URL Routing**: Portal uses /runs/{id}, Local uses /projects/{pid}/tesbo-reports/runs
- **Navigation**: Different breadcrumb structure
- **Table Structure**: Different
- **Buttons**: 19 missing, 8 extra
- **Headings**: 1 missing, 2 extra

### Critical Gaps
- Missing buttons: Toggle theme, Logout, New project, Refresh data, API fvfgzv••••sp, API jsywrk••••sp, API fitkbt••••fj, API bofuab••••ix, API pqyfpc••••yy, API yfechs••••ib, API xyjkdj••••jx, API ibhfss••••dc, API ycgnpy••••ch, API lmuetm••••ed, API bqicmn••••va, API jzoazl••••xc, API ydqofi••••kk, API xgygne••••xq, API mcaoxr••••lh
- Missing sections: Project catalogue

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

```json
{
  "url": "https://portal.tesbo.io/projects",
  "title": "Tesbo Cloud Reporting",
  "headings": [
    {
      "tag": "H2",
      "text": "Project catalogue"
    }
  ],
  "buttons": [
    {
      "text": "",
      "disabled": false
    },
    {
      "text": "Toggle theme",
      "disabled": false
    },
    {
      "text": "Logout",
      "disabled": false
    },
    {
      "text": "New project",
      "disabled": false
    },
    {
      "text": "Refresh data",
      "disabled": false
    },
    {
      "text": "API fvfgzv••••sp",
      "disabled": false
    },
    {
      "text": "API jsywrk••••sp",
      "disabled": false
    },
    {
      "text": "API fitkbt••••fj",
      "disabled": false
    },
    {
      "text": "API bofuab••••ix",
      "disabled": false
    },
    {
      "text": "API pqyfpc••••yy",
      "disabled": false
    },
    {
      "text": "API yfechs••••ib",
      "disabled": false
    },
    {
      "text": "API xyjkdj••••jx",
      "disabled": false
    },
    {
      "text": "API ibhfss••••dc",
      "disabled": false
    },
    {
      "text": "API ycgnpy••••ch",
      "disabled": false
    },
    {
      "text": "API lmuetm••••ed",
      "disabled": false
    },
    {
      "text": "API bqicmn••••va",
      "disabled": false
    },
    {
      "text": "API jzoazl••••xc",
      "disabled": false
    },
    {
      "text": "API ydqofi••••kk",
      "disabled": false
    },
    {
      "text": "API xgygne••••xq",
      "disabled": false
    },
    {
      "text": "API mcaoxr••••lh",
      "disabled": false
    }
  ],
  "breadcrumbs": [
    "Home"
  ],
  "tabs": [],
  "labels": [],
  "badges": [],
  "tableHeaders": [],
  "inputs": [],
  "selects": []
}
```

</details>

<details>
<summary>Local Data (JSON)</summary>

```json
{
  "url": "http://localhost:3000/projects/4804a8b3-7c9c-4f2d-807f-c52ba1a2380f/tesbo-reports/runs",
  "title": "TesboX",
  "headings": [
    {
      "tag": "H1",
      "text": "Tesbo Runs"
    },
    {
      "tag": "H2",
      "text": "Build history"
    }
  ],
  "buttons": [
    {
      "text": "Upload build file",
      "disabled": false
    },
    {
      "text": "Refresh",
      "disabled": false
    },
    {
      "text": "Ingest sample",
      "disabled": false
    },
    {
      "text": "Last 30 days",
      "disabled": false
    },
    {
      "text": "Last 7 days",
      "disabled": false
    },
    {
      "text": "All time",
      "disabled": false
    },
    {
      "text": "Prev",
      "disabled": true
    },
    {
      "text": "Next",
      "disabled": true
    },
    {
      "text": "",
      "disabled": false
    }
  ],
  "breadcrumbs": [
    "Home",
    "Dashboard",
    "Project",
    "Test Generation",
    "Generation History",
    "Knowledge Base",
    "Test case Repository",
    "Test Plan",
    "Test Run",
    "Bugs",
    "Test Reports",
    "Activity",
    "Overview",
    "Runs",
    "Specs",
    "Tests",
    "Analytics",
    "Project settings",
    "Workspace settings"
  ],
  "tabs": [],
  "labels": [],
  "badges": [],
  "tableHeaders": [
    "Run #",
    "Name",
    "Branch",
    "PR",
    "Commit author",
    "GitHub build",
    "Status",
    "Totals",
    "Source",
    "Started",
    "Details"
  ],
  "inputs": [
    {
      "type": "file",
      "placeholder": "",
      "name": ""
    },
    {
      "type": "text",
      "placeholder": "Search name, branch, PR, author, run #",
      "name": ""
    }
  ],
  "selects": [
    {
      "name": "",
      "options": [
        "All status",
        "Passed",
        "Failed",
        "Skipped"
      ]
    },
    {
      "name": "",
      "options": [
        "All sources"
      ]
    }
  ],
  "runDetailUrl": "http://localhost:3000/projects/4804a8b3-7c9c-4f2d-807f-c52ba1a2380f/tesbo-reports/runs",
  "runDetailHeadings": [
    {
      "tag": "H1",
      "text": "Tesbo Runs"
    },
    {
      "tag": "H2",
      "text": "Build history"
    }
  ],
  "runDetailButtons": [
    "Upload build file",
    "Refresh",
    "Ingest sample",
    "Last 30 days",
    "Last 7 days",
    "All time",
    "Prev",
    "Next",
    ""
  ],
  "testDetailVisible": false
}
```

</details>

<details>
<summary>Comparison Data (JSON)</summary>

```json
{
  "urls": {
    "portal": "https://portal.tesbo.io/projects",
    "local": "http://localhost:3000/projects/4804a8b3-7c9c-4f2d-807f-c52ba1a2380f/tesbo-reports/runs",
    "patternDiff": "Portal uses /runs/{id}, Local uses /projects/{pid}/tesbo-reports/runs"
  },
  "headings": {
    "portal": [
      {
        "tag": "H2",
        "text": "Project catalogue"
      }
    ],
    "local": [
      {
        "tag": "H1",
        "text": "Tesbo Runs"
      },
      {
        "tag": "H2",
        "text": "Build history"
      }
    ],
    "diff": {
      "missingInLocal": [
        "Project catalogue"
      ],
      "extraInLocal": [
        "Tesbo Runs",
        "Build history"
      ]
    }
  },
  "buttons": {
    "portalCount": 20,
    "localCount": 9,
    "portalButtons": [
      "Toggle theme",
      "Logout",
      "New project",
      "Refresh data",
      "API fvfgzv••••sp",
      "API jsywrk••••sp",
      "API fitkbt••••fj",
      "API bofuab••••ix",
      "API pqyfpc••••yy",
      "API yfechs••••ib",
      "API xyjkdj••••jx",
      "API ibhfss••••dc",
      "API ycgnpy••••ch",
      "API lmuetm••••ed",
      "API bqicmn••••va",
      "API jzoazl••••xc",
      "API ydqofi••••kk",
      "API xgygne••••xq",
      "API mcaoxr••••lh"
    ],
    "localButtons": [
      "Upload build file",
      "Refresh",
      "Ingest sample",
      "Last 30 days",
      "Last 7 days",
      "All time",
      "Prev",
      "Next"
    ],
    "missingInLocal": [
      "Toggle theme",
      "Logout",
      "New project",
      "Refresh data",
      "API fvfgzv••••sp",
      "API jsywrk••••sp",
      "API fitkbt••••fj",
      "API bofuab••••ix",
      "API pqyfpc••••yy",
      "API yfechs••••ib",
      "API xyjkdj••••jx",
      "API ibhfss••••dc",
      "API ycgnpy••••ch",
      "API lmuetm••••ed",
      "API bqicmn••••va",
      "API jzoazl••••xc",
      "API ydqofi••••kk",
      "API xgygne••••xq",
      "API mcaoxr••••lh"
    ],
    "extraInLocal": [
      "Upload build file",
      "Refresh",
      "Ingest sample",
      "Last 30 days",
      "Last 7 days",
      "All time",
      "Prev",
      "Next"
    ]
  },
  "navigation": {
    "portalBreadcrumbs": [
      "Home"
    ],
    "localBreadcrumbs": [
      "Home",
      "Dashboard",
      "Project",
      "Test Generation",
      "Generation History",
      "Knowledge Base",
      "Test case Repository",
      "Test Plan",
      "Test Run",
      "Bugs",
      "Test Reports",
      "Activity",
      "Overview",
      "Runs",
      "Specs",
      "Tests",
      "Analytics",
      "Project settings",
      "Workspace settings"
    ],
    "diff": "Different breadcrumb structure"
  },
  "tabs": {
    "portal": [],
    "local": [],
    "diff": "Similar"
  },
  "tables": {
    "portalHeaders": [],
    "localHeaders": [
      "Run #",
      "Name",
      "Branch",
      "PR",
      "Commit author",
      "GitHub build",
      "Status",
      "Totals",
      "Source",
      "Started",
      "Details"
    ],
    "portalColumns": 0,
    "localColumns": 11
  },
  "inputs": {
    "portalInputs": [],
    "localInputs": [
      {
        "type": "file",
        "placeholder": "",
        "name": ""
      },
      {
        "type": "text",
        "placeholder": "Search name, branch, PR, author, run #",
        "name": ""
      }
    ],
    "placeholderDiff": []
  },
  "filters": {
    "portalSelects": [],
    "localSelects": [
      {
        "name": "",
        "options": [
          "All status",
          "Passed",
          "Failed",
          "Skipped"
        ]
      },
      {
        "name": "",
        "options": [
          "All sources"
        ]
      }
    ]
  }
}
```

</details>
