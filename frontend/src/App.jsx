import React, { useState, useEffect, useRef } from 'react'
import Sidebar from './components/layout/Sidebar.jsx'
import TopBar from './components/layout/TopBar.jsx'
import CommandCenter from './components/screens/CommandCenter.jsx'
import ProjectSelection from './components/screens/ProjectSelection.jsx'
import ProjectIntelligence from './components/screens/ProjectIntelligence.jsx'
import CampaignRecommendations from './components/screens/CampaignRecommendations.jsx'
import CreativeStudio from './components/screens/CreativeStudio.jsx'
import CampaignDeployment from './components/screens/CampaignDeployment.jsx'
import LeadCapture from './components/screens/LeadCapture.jsx'
import LeadScoring from './components/screens/LeadScoring.jsx'
import JunkDetection from './components/screens/JunkDetection.jsx'
import AICallingAgent from './components/screens/AICallingAgent.jsx'
import WhatsAppAgent from './components/screens/WhatsAppAgent.jsx'
import AIWorkforce from './components/screens/AIWorkforce.jsx'
import SalesCRM from './components/screens/SalesCRM.jsx'
import BuilderCollaboration from './components/screens/BuilderCollaboration.jsx'
import AIAnalytics from './components/screens/AIAnalytics.jsx'
import AIRecommendations from './components/screens/AIRecommendations.jsx'
import CallerDashboard from './components/screens/CallerDashboard.jsx'
import UserManagement from './components/screens/UserManagement.jsx'

const SCREENS = {
  command: CommandCenter,
  select: ProjectSelection,
  project: ProjectIntelligence,
  reco: CampaignRecommendations,
  studio: CreativeStudio,
  deploy: CampaignDeployment,
  capture: LeadCapture,
  scoring: LeadScoring,
  junk: JunkDetection,
  calling: AICallingAgent,
  whatsapp: WhatsAppAgent,
  workforce: AIWorkforce,
  crm: SalesCRM,
  builder: BuilderCollaboration,
  analytics: AIAnalytics,
  recommend: AIRecommendations,
  callers: CallerDashboard,
  users: UserManagement,
}

export default function App() {
  const [view, setView] = useState('command')
  const [selectedProjects, setSelectedProjects] = useState([])
  // Lets a screen append one extra breadcrumb segment (e.g. Lead Capture's
  // detail view appending the lead's name: "propOG / Lead Capture /
  // Usha Sahni") without TopBar needing to know about any screen's internal
  // state. Cleared on every navigation so a stale name never lingers into a
  // different screen.
  const [breadcrumbExtra, setBreadcrumbExtra] = useState(null)
  const Screen = SCREENS[view] || CommandCenter

  // Real, live-reported bug: the div below is the app's actual scrollable
  // viewport (overflowY: auto — the outer <div> has overflow: hidden and
  // never scrolls). Clicking "Open Project Intelligence" from a card low in
  // a long AI Search results list left this div's scrollTop deep from the
  // PREVIOUS screen; swapping in a shorter screen (Project Intelligence)
  // didn't reset it, so the browser clamped scrollTop to the new, smaller
  // max — landing the user at the BOTTOM of the new screen instead of the
  // top. Fixed once here, in changeView, since every navigation path
  // (sidebar, onBack, onAnalyse) already routes through it.
  const scrollRef = useRef(null)
  const changeView = (v) => { setBreadcrumbExtra(null); setView(v) }
  useEffect(() => { if (scrollRef.current) scrollRef.current.scrollTop = 0 }, [view])

  const screenProps = {}
  if (view === 'select') {
    screenProps.onAnalyse = (projects) => {
      setSelectedProjects(projects)
      changeView('project')
    }
  }
  if (view === 'project') {
    screenProps.selectedProjects = selectedProjects
    // Same state-based navigation ProjectSelection -> ProjectIntelligence
    // already uses, just the reverse direction — no router, no URL param,
    // no new state model. ProjectSelection's own sessionMemory (module-
    // scope, already survives this exact unmount/remount) restores the
    // prior query/results/tab/filters automatically once 'select' is
    // active again.
    screenProps.onBack = () => changeView('select')
  }
  if (view === 'capture') {
    screenProps.onBreadcrumbExtra = setBreadcrumbExtra
  }

  return (
    <div style={{ display:'flex', height:'100vh', overflow:'hidden', fontFamily:'var(--pg-font)' }}>
      <Sidebar active={view} setView={changeView} />
      <div ref={scrollRef} style={{ flex:1, display:'flex', flexDirection:'column', overflowY:'auto', background:'var(--pg-shell)', minWidth:0 }}>
        <TopBar view={view} breadcrumbExtra={breadcrumbExtra} />
        <div style={{ flex:1 }}>
          <Screen {...screenProps} />
        </div>
      </div>
    </div>
  )
}