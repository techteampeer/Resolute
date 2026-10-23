import React from 'react'
import { useNavigate } from 'react-router-dom'
import {
  ShieldCheck, Bell, DollarSign, Users, Landmark, Mail, CheckCircle,
  AlertTriangle, ChevronRight, Building2, Clock, Lock,
} from 'lucide-react'
import { useAuth } from '../../context/AuthContext'
import { canConfirmPayments, REMITTANCE, hasRemittanceDetails, TERMS } from '../../lib/billing'
import { PAYOUT_CYCLES } from '../../lib/payouts'

// Light theme palette — matches AdminBilling / the rest of the admin portal.
const Q = {
  bg: '#F3F5F8', card: '#ffffff', border: '#DDE3EC', text: '#12284C',
  muted: '#5C6E8C', faint: '#9AA8BF',
  shadow: '0 1px 3px rgba(0,0,0,0.08), 0 1px 2px rgba(0,0,0,0.04)',
}
const ACCENT = '#2441E5'

// A titled white card. `hint` is the small grey line under the heading.
function Card({ icon: Icon, title, hint, children }) {
  return (
    <div style={{ background: Q.card, border: `1px solid ${Q.border}`, borderRadius: 14, boxShadow: Q.shadow }}>
      <div style={{ padding: '14px 18px', borderBottom: `1px solid ${Q.border}` }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontWeight: 700, fontSize: 14, color: Q.text }}>
          {Icon && <Icon style={{ width: 16, height: 16, color: ACCENT }} />} {title}
        </div>
        {hint && <div style={{ fontSize: 12, color: Q.faint, marginTop: 2 }}>{hint}</div>}
      </div>
      <div style={{ padding: '6px 18px 14px' }}>{children}</div>
    </div>
  )
}

// Label on the left, value on the right — the account / org detail rows.
function Row({ label, children }) {
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 16,
      padding: '11px 0', borderBottom: `1px solid ${Q.bg}` }}>
      <span style={{ fontSize: 12.5, color: Q.muted, flexShrink: 0 }}>{label}</span>
      <span style={{ fontSize: 13, color: Q.text, fontWeight: 600, textAlign: 'right', minWidth: 0 }}>{children}</span>
    </div>
  )
}

// Green "configured" / amber "not set" pill for the remittance rows.
function StatusPill({ ok, okText, offText }) {
  const c = ok ? '#15803d' : '#b45309'
  const Icon = ok ? CheckCircle : AlertTriangle
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5, fontSize: 12, fontWeight: 600, color: c }}>
      <Icon style={{ width: 13, height: 13 }} /> {ok ? okText : offText}
    </span>
  )
}

export default function AdminSettings() {
  const navigate = useNavigate()
  const { user } = useAuth()

  const superAdmin = !!user?.superAdmin
  const confirmsMoney = canConfirmPayments(user)
  const roleLabel = superAdmin ? 'Super Admin' : 'Admin'
  // The money-movement capability line mirrors billing.js / the payout guards —
  // read-only here; only the billing admin (Vivek) actually confirms funds.
  const moneyCapability = confirmsMoney
    ? 'You confirm client deposits and release vendor payouts & subscriptions.'
    : superAdmin
      ? 'You view payouts and enter vendor fees. Only the billing admin confirms funds.'
      : 'View only for money movement — the billing admin confirms deposits and payouts.'

  const achReady = hasRemittanceDetails
  const checkReady = Boolean(REMITTANCE.payee && REMITTANCE.checkAddress)

  // The settings that live inside feature areas — surfaced here as one hub.
  const configure = [
    { icon: DollarSign, title: 'Billing & payouts', to: '/admin/billing',
      desc: 'Client payment terms, vendor payout cycles, subscriptions, and deposit confirmation.' },
    { icon: Bell, title: 'Email notifications', to: '/admin/notifications',
      desc: 'Which alerts you receive, and how often — immediate or a daily digest.' },
    { icon: Users, title: 'Team & roles', to: '/admin/users',
      desc: 'The staff roster — admins and the production desk.' },
  ]

  return (
    <div style={{ maxWidth: 860, margin: '0 auto' }} className="space-y-5">
      <div>
        <h1 style={{ fontSize: 24, fontWeight: 800, color: Q.text }}>Settings</h1>
        <p style={{ fontSize: 14, color: Q.muted, marginTop: 2 }}>
          Your account, the firm&apos;s billing profile, and where everything is configured.
        </p>
      </div>

      {/* My account */}
      <Card icon={ShieldCheck} title="My account" hint="Who you are signed in as, and what you can do.">
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '11px 0', borderBottom: `1px solid ${Q.bg}` }}>
          <div style={{ width: 42, height: 42, borderRadius: '50%', flexShrink: 0, display: 'flex',
            alignItems: 'center', justifyContent: 'center', fontWeight: 700, fontSize: 14,
            color: ACCENT, background: `${ACCENT}16`, border: `1px solid ${ACCENT}33` }}>
            {user?.avatar || (user?.name || '?').slice(0, 2).toUpperCase()}
          </div>
          <div style={{ minWidth: 0 }}>
            <div style={{ fontSize: 15, fontWeight: 700, color: Q.text }}>{user?.name || '—'}</div>
            <div style={{ fontSize: 12.5, color: Q.muted }}>{user?.email || '—'}</div>
          </div>
        </div>
        <Row label="Role">
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
            {superAdmin && <ShieldCheck style={{ width: 14, height: 14, color: ACCENT }} />}
            {roleLabel}
          </span>
        </Row>
        <Row label="Money movement">
          <span style={{ fontWeight: 500, color: Q.muted, fontSize: 12.5 }}>{moneyCapability}</span>
        </Row>
      </Card>

      {/* Organization / billing profile */}
      <Card icon={Building2} title="Organization"
        hint="The firm's billing identity. Shown on client invoices and the billing page.">
        <Row label="Firm">Resolute Title Services</Row>
        <Row label="Billing contact">
          <a href={`mailto:${REMITTANCE.billingEmail}`} style={{ color: ACCENT }}>{REMITTANCE.billingEmail}</a>
        </Row>
        <Row label={<span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}><Landmark style={{ width: 13, height: 13 }} /> ACH details</span>}>
          <StatusPill ok={achReady}
            okText={`${REMITTANCE.bankName || 'Bank'} · ••${String(REMITTANCE.accountNumber || '').slice(-4)}`}
            offText="Not configured" />
        </Row>
        <Row label={<span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}><Mail style={{ width: 13, height: 13 }} /> Check remittance</span>}>
          <StatusPill ok={checkReady} okText={REMITTANCE.payee || 'Configured'} offText="Not configured" />
        </Row>
        {(!achReady || !checkReady) && (
          <div style={{ marginTop: 10, fontSize: 12, color: Q.muted, lineHeight: 1.5,
            background: 'rgba(180,83,9,0.07)', border: '1px solid rgba(180,83,9,0.18)', borderRadius: 10, padding: '10px 12px' }}>
            <AlertTriangle style={{ width: 13, height: 13, color: '#b45309', verticalAlign: '-2px', marginRight: 5 }} />
            Remittance details aren&apos;t set yet, so invoices and the client billing page show the billing email
            instead of bank / check instructions. These are managed by Resolute engineering for now;
            in-portal editing lands with the GCP migration.
          </div>
        )}
      </Card>

      {/* Billing cycles reference */}
      <Card icon={Clock} title="Billing cycles"
        hint="The cycles available across the portal. Set per client and per vendor in Billing.">
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 18, paddingTop: 8 }}>
          <div>
            <div style={{ fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.04em', color: Q.faint, marginBottom: 6 }}>Client payment terms</div>
            {TERMS.map(t => (
              <div key={t.key} style={{ fontSize: 12.5, color: Q.text, padding: '3px 0' }}>
                <span style={{ fontWeight: 600 }}>{t.label}</span>
                <span style={{ color: Q.faint }}> — {t.desc}</span>
              </div>
            ))}
          </div>
          <div>
            <div style={{ fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.04em', color: Q.faint, marginBottom: 6 }}>Vendor payout cycles</div>
            {PAYOUT_CYCLES.map(c => (
              <div key={c.key} style={{ fontSize: 12.5, color: Q.text, padding: '3px 0' }}>
                <span style={{ fontWeight: 600 }}>{c.label}</span>
                <span style={{ color: Q.faint }}> — {c.desc}</span>
              </div>
            ))}
          </div>
        </div>
      </Card>

      {/* Configure hub */}
      <div>
        <div style={{ fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.05em', color: Q.faint, margin: '2px 2px 8px' }}>Configure</div>
        <div className="space-y-3">
          {configure.map(c => (
            <button key={c.to} onClick={() => navigate(c.to)}
              style={{ width: '100%', textAlign: 'left', display: 'flex', alignItems: 'center', gap: 14,
                background: Q.card, border: `1px solid ${Q.border}`, borderRadius: 14, boxShadow: Q.shadow,
                padding: '15px 18px', cursor: 'pointer' }}>
              <div style={{ width: 38, height: 38, borderRadius: 10, flexShrink: 0, display: 'flex',
                alignItems: 'center', justifyContent: 'center', color: ACCENT, background: `${ACCENT}12` }}>
                <c.icon style={{ width: 18, height: 18 }} />
              </div>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 14, fontWeight: 700, color: Q.text }}>{c.title}</div>
                <div style={{ fontSize: 12.5, color: Q.muted, marginTop: 1 }}>{c.desc}</div>
              </div>
              <ChevronRight style={{ width: 18, height: 18, color: Q.faint, flexShrink: 0 }} />
            </button>
          ))}
        </div>
      </div>

      <div style={{ display: 'flex', alignItems: 'center', gap: 7, justifyContent: 'center',
        fontSize: 11.5, color: Q.faint, paddingTop: 2 }}>
        <Lock style={{ width: 12, height: 12 }} />
        Client identities, payment confirmation, and payouts are guarded server-side — these settings never widen access.
      </div>
    </div>
  )
}
