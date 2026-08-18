param(
  [string]$BaseUrl = "http://localhost:3001",
  [switch]$SkipBuild
)

$ErrorActionPreference = "Stop"

function Write-Check {
  param([string]$Name, [string]$Status, [string]$Detail = "")
  $line = "{0,-42} {1}" -f $Name, $Status
  if ($Detail) { $line = "$line  $Detail" }
  Write-Host $line
}

function Invoke-Json {
  param(
    [string]$Method = "GET",
    [string]$Path,
    [object]$Body = $null
  )
  $uri = "$BaseUrl$Path"
  $params = @{
    Uri = $uri
    Method = $Method
    UseBasicParsing = $true
    TimeoutSec = 30
  }
  if ($null -ne $Body) {
    $params.ContentType = "application/json"
    $params.Body = ($Body | ConvertTo-Json -Depth 20)
  }
  try {
    $response = Invoke-WebRequest @params
    return @{
      Ok = $true
      Status = [int]$response.StatusCode
      Json = ($response.Content | ConvertFrom-Json)
      Raw = $response.Content
    }
  } catch {
    $status = $null
    $raw = $_.Exception.Message
    if ($_.Exception.Response) {
      $status = [int]$_.Exception.Response.StatusCode
      try {
        $reader = New-Object System.IO.StreamReader($_.Exception.Response.GetResponseStream())
        $raw = $reader.ReadToEnd()
      } catch {}
    }
    return @{
      Ok = $false
      Status = $status
      Json = $null
      Raw = $raw
    }
  }
}

Write-Host "IndiHomes OS smoke test"
Write-Host "Backend: $BaseUrl"
Write-Host ""

if (-not $SkipBuild) {
  Write-Host "Running production build..."
  npm run build
  Write-Host ""
}

$health = Invoke-Json -Path "/"
if ($health.Ok) {
  Write-Check "Backend reachable" "PASS" "HTTP $($health.Status)"
} else {
  Write-Check "Backend reachable" "FAIL" "Start it with: npm run server"
  Write-Host $health.Raw
  exit 1
}

$projects = Invoke-Json -Path "/api/projects"
if ($projects.Ok -and $projects.Json.projects) {
  $items = @($projects.Json.projects)
  $count = $items.Count
  $sourceNames = @(
    $items | ForEach-Object {
      if ($_.sources) { $_.sources }
      if ($_.adSrc) { $_.adSrc }
      if ($_.sourceLabel) { $_.sourceLabel }
    } | Where-Object { $_ } | ForEach-Object { $_ }
  ) | Sort-Object -Unique
  $hasPortalSources = @($sourceNames | Where-Object { $_ -match "99acres|magicbricks|google" }).Count -gt 0
  $hasOfficialSource = @($sourceNames | Where-Object { $_ -match "indihomes-website|IndiHomes Website" }).Count -gt 0

  Write-Check "/api/projects returns projects" "PASS" "$count projects"
  if ($hasPortalSources) {
    Write-Check "Filter Search source rule" "FAIL" "Still contains portal/google sources: $($sourceNames -join ', ')"
  } elseif ($hasOfficialSource) {
    Write-Check "Filter Search source rule" "PASS" "Only official IndiHomes website sources detected"
  } else {
    Write-Check "Filter Search source rule" "WARN" "No portal sources found, but official source labels were not present"
  }
} else {
  Write-Check "/api/projects returns projects" "FAIL" $projects.Raw
}

$aiStatus = Invoke-Json -Path "/api/ai-status"
if ($aiStatus.Ok) {
  Write-Check "/api/ai-status" "PASS" "enabled=$($aiStatus.Json.enabled), provider=$($aiStatus.Json.provider)"
} else {
  Write-Check "/api/ai-status" "FAIL" $aiStatus.Raw
}

$aiSearch = Invoke-Json -Method "POST" -Path "/api/ai-search" -Body @{
  query = "2 bed apartment in Dubai Marina under AED 2M ready to move"
  market = "dubai"
}
if ($aiSearch.Ok) {
  $aiItems = @($aiSearch.Json.properties).Count
  Write-Check "AI Search Dubai endpoint" "PASS" "$aiItems properties"
  if ($aiSearch.Json._provider) {
    Write-Check "AI Search no-Claude requirement" "FAIL" "Still reports provider=$($aiSearch.Json._provider)"
  } else {
    Write-Check "AI Search no-Claude requirement" "PASS"
  }
} else {
  if ($aiSearch.Raw -match "ANTHROPIC_API_KEY|Claude") {
    Write-Check "AI Search no-Claude requirement" "FAIL" $aiSearch.Raw
  } else {
    Write-Check "AI Search Dubai endpoint" "FAIL" $aiSearch.Raw
  }
}

$filterRank = Invoke-Json -Method "POST" -Path "/api/filter-rank" -Body @{
  filters = @{ locations = @("Thane"); budget = "All"; configs = @("2 BHK"); possession = "All" }
  candidates = @(@{ name = "Test Project"; city = "Thane"; location = "Thane"; config = "2 BHK"; budgetMin = 100; budgetMax = 150 })
}
if ($filterRank.Ok) {
  $rankRaw = $filterRank.Raw
  if ($rankRaw -match "ANTHROPIC_API_KEY|Claude|provider") {
    Write-Check "Filter Search deterministic scoring" "FAIL" "Response still looks AI/Claude-backed"
  } else {
    Write-Check "Filter Search deterministic scoring" "PASS"
  }
} else {
  if ($filterRank.Raw -match "ANTHROPIC_API_KEY|Not configured") {
    Write-Check "Filter Search deterministic scoring" "FAIL" $filterRank.Raw
  } else {
    Write-Check "Filter Search deterministic scoring" "WARN" $filterRank.Raw
  }
}

$leads = Invoke-Json -Path "/api/leads?limit=5"
if ($leads.Ok) {
  $leadCount = @($leads.Json.leads).Count
  Write-Check "/api/leads" "PASS" "$leadCount leads returned"
} else {
  Write-Check "/api/leads" "FAIL" $leads.Raw
}

$housing = Invoke-Json -Method "POST" -Path "/api/leads/sync-housing" -Body @{}
if ($housing.Ok) {
  Write-Check "Housing sync endpoint" "PASS"
} else {
  Write-Check "Housing sync endpoint" "WARN" $housing.Raw
}

$meta = Invoke-Json -Method "POST" -Path "/api/leads/sync-meta" -Body @{}
if ($meta.Ok) {
  Write-Check "Meta sync endpoint" "PASS"
} else {
  Write-Check "Meta sync endpoint" "WARN" $meta.Raw
}

Write-Host ""
Write-Host "Expected after the new implementation:"
Write-Host "- Filter Search source rule should PASS with only IndiHomes website inventory."
Write-Host "- AI Search no-Claude requirement should PASS and use Azure/external search."
Write-Host "- Dubai should work only through AI Search, not Filter Search."
Write-Host "- Lead sync WARN is acceptable locally until credentials are added."
