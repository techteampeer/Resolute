import React from 'react'
import OrderWizard from '../../components/OrderWizard'

// A1 — Admin places an order ON BEHALF OF a client. The whole form is the shared
// OrderWizard in admin mode: a leading Client step (existing clients only) then
// the same 4-step intake the client portal uses (Property → Search → Contact →
// Review), so the two can never drift. createOrder parks it in the normal initial
// Admin state and the wizard lands on the order to confirm, price and route it.
export default function AdminPlaceOrder() {
  return <OrderWizard mode="admin" />
}
