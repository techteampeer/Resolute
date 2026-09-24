import React, { lazy, Suspense } from 'react'
import { BrowserRouter, Routes, Route, Navigate, useLocation } from 'react-router-dom'
import { AuthProvider, useAuth } from './context/AuthContext'
import { OrderProvider } from './context/OrderContext'
import { FulfillmentProvider } from './context/FulfillmentContext'
import { SupportProvider } from './context/SupportContext'
import LoginPage from './pages/LoginPage'
// Dashboards are route-split: a signed-in user downloads only their own portal,
// not all seven. This also stops a client's bundle from carrying the admin,
// billing, payout and fulfillment code (defence-in-depth + smaller client app).
const AdminDashboard     = lazy(() => import('./pages/admin/AdminDashboard'))
const ClientDashboard    = lazy(() => import('./pages/client/ClientDashboard'))
// The single production workspace (ADR 0001). The four stage portals
// (screener/examiner/typer/delivery) were retired in D3 — production staff log
// in as `user` and work every stage here, with the Admin approval gate kept.
const OperatorDashboard  = lazy(() => import('./pages/operator/OperatorDashboard'))

// Shown only while the stored session is being checked — a fraction of a second
// on a cold load. Rendering nothing here would flash the page white; redirecting
// (what used to happen) threw the user out of their own session.
function SessionGate() {
  return <div style={{ minHeight: '60vh', display: 'grid', placeItems: 'center', color: '#5C6E8C', fontSize: 13 }}>Loading…</div>
}

function ProtectedRoute({ children, allowedRole }) {
  const { user, ready } = useAuth()
  const location = useLocation()
  // Wait for the session check. Treating "not resolved yet" as "signed out" is
  // what made every refresh and every emailed deep link land on the login page.
  if (!ready) return <SessionGate />
  if (!user) {
    // Carry the destination through the login round-trip. Without this, a link
    // from a notification email ("Approve and assign →") drops the signed-out
    // recipient on their dashboard and they have to hunt for the order — which
    // makes deep links in mail pointless.
    const from = location.pathname + location.search
    return <Navigate to={allowedRole === 'client' ? '/login' : '/staff'} replace state={{ from }} />
  }
  if (user.role !== allowedRole) return <Navigate to={`/${user.role}`} replace />
  return children
}

function RoleRedirect() {
  const { user, ready } = useAuth()
  if (!ready) return <SessionGate />
  if (!user) return <Navigate to="/login" replace />
  return <Navigate to={`/${user.role}`} replace />
}

export default function App() {
  return (
    <AuthProvider>
      <OrderProvider>
      <FulfillmentProvider>
      <SupportProvider>
      <BrowserRouter future={{ v7_startTransition: true, v7_relativeSplatPath: true }}>
        <Suspense fallback={<SessionGate />}>
        <Routes>
          <Route path="/login" element={<LoginPage variant="client" />} />
          <Route path="/staff" element={<LoginPage variant="staff" />} />
          <Route path="/" element={<RoleRedirect />} />
          <Route path="/admin/*" element={
            <ProtectedRoute allowedRole="admin"><AdminDashboard /></ProtectedRoute>
          } />
          <Route path="/client/*" element={
            <ProtectedRoute allowedRole="client"><ClientDashboard /></ProtectedRoute>
          } />
          <Route path="/user/*" element={
            <ProtectedRoute allowedRole="user"><OperatorDashboard /></ProtectedRoute>
          } />
          <Route path="*" element={<Navigate to="/login" replace />} />
        </Routes>
        </Suspense>
      </BrowserRouter>
      </SupportProvider>
      </FulfillmentProvider>
      </OrderProvider>
    </AuthProvider>
  )
}
