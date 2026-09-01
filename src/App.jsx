import React from 'react'
import { BrowserRouter, Routes, Route, Navigate, useLocation } from 'react-router-dom'
import { AuthProvider, useAuth } from './context/AuthContext'
import { OrderProvider } from './context/OrderContext'
import { FulfillmentProvider } from './context/FulfillmentContext'
import { SupportProvider } from './context/SupportContext'
import LoginPage from './pages/LoginPage'
import AdminDashboard from './pages/admin/AdminDashboard'
import ScreenerDashboard from './pages/screener/ScreenerDashboard'
import ExaminerDashboard from './pages/examiner/ExaminerDashboard'
import TyperDashboard from './pages/typer/TyperDashboard'
import DeliveryDashboard from './pages/delivery/DeliveryDashboard'
import ClientDashboard from './pages/client/ClientDashboard'
import OperatorDashboard from './pages/operator/OperatorDashboard'

function ProtectedRoute({ children, allowedRole }) {
  const { user } = useAuth()
  const location = useLocation()
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
  const { user } = useAuth()
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
        <Routes>
          <Route path="/login" element={<LoginPage variant="client" />} />
          <Route path="/staff" element={<LoginPage variant="staff" />} />
          <Route path="/" element={<RoleRedirect />} />
          <Route path="/admin/*" element={
            <ProtectedRoute allowedRole="admin"><AdminDashboard /></ProtectedRoute>
          } />
          <Route path="/screener/*" element={
            <ProtectedRoute allowedRole="screener"><ScreenerDashboard /></ProtectedRoute>
          } />
          <Route path="/examiner/*" element={
            <ProtectedRoute allowedRole="examiner"><ExaminerDashboard /></ProtectedRoute>
          } />
          <Route path="/typer/*" element={
            <ProtectedRoute allowedRole="typer"><TyperDashboard /></ProtectedRoute>
          } />
          <Route path="/delivery/*" element={
            <ProtectedRoute allowedRole="delivery"><DeliveryDashboard /></ProtectedRoute>
          } />
          <Route path="/client/*" element={
            <ProtectedRoute allowedRole="client"><ClientDashboard /></ProtectedRoute>
          } />
          <Route path="/operator/*" element={
            <ProtectedRoute allowedRole="operator"><OperatorDashboard /></ProtectedRoute>
          } />
          <Route path="*" element={<Navigate to="/login" replace />} />
        </Routes>
      </BrowserRouter>
      </SupportProvider>
      </FulfillmentProvider>
      </OrderProvider>
    </AuthProvider>
  )
}
