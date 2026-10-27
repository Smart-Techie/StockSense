# StockSense Supabase Email Branding & Configuration Guide

**Project Name**: StockSense  
**Tagline**: *“Know Your Stock. Grow Your Business.”*  
**Target Supabase Project**: `fjwpzuaaxuwdbwwqfvdp` (`https://fjwpzuaaxuwdbwwqfvdp.supabase.co`)  
**Production Site URL**: `https://stocksense-psi.vercel.app`  

---

## Root Cause of Supabase Branding in Emails

Authentication emails sent by Supabase have **two distinct layers** of branding:

1. **Email HTML Body & Subject Line**:
   - Managed under **Supabase Dashboard -> Authentication -> Email Templates**.
   - Supabase **does not automatically read local template files** from your Git repository. The HTML templates in this folder must be pasted into the Supabase Dashboard (or pushed via the Supabase Management API).
   - If this step has not been done in the dashboard, users will receive Supabase's default generic HTML email layout.

2. **Sender Display Name & "From" Email Address**:
   - By default, Supabase sends transactional emails using its shared internal SMTP relay (`noreply@mail.app.supabase.io`) with the sender display name `Supabase Auth` or `Supabase`.
   - **Crucial limitation**: Supabase's default shared mailer **does not permit customizing the sender email address or sender name**. Any changes made to the "Sender Name" field in the dashboard template settings are ignored or restricted unless a **Custom SMTP Provider** is enabled.
   - Furthermore, the default Supabase mailer is strictly rate-limited (2 emails/hour in free tier) and restricted.
   - **To display `StockSense <notifications@yourdomain.com>` as the sender, Custom SMTP MUST be enabled in the Supabase Dashboard.**

---

## Step 1: Configure Custom SMTP in Supabase (For Sender Branding)

To brand the "From" address as StockSense:

1. Sign up for or log in to a transactional email service:
   - **Resend** (Recommended, quickest setup): `https://resend.com`
   - **SendGrid**: `https://sendgrid.com`
   - **Postmark**: `https://postmarkapp.com`
   - **Amazon SES**: `https://aws.amazon.com/ses/`
   - **Brevo**: `https://www.brevo.com`
2. In your email provider:
   - Verify your sending domain (e.g., `stocksense.com`, `stocksense.ng`, or your custom domain).
   - Generate an SMTP API Key / credentials.
3. Open the Supabase Dashboard:
   `https://supabase.com/dashboard/project/fjwpzuaaxuwdbwwqfvdp/settings/auth`
4. Scroll to **SMTP Settings** and toggle **Enable Custom SMTP**:
   - **Sender email**: `noreply@yourdomain.com` (or `support@yourdomain.com`)
   - **Sender name**: `StockSense`
   - **Host**: (e.g. `smtp.resend.com` for Resend, `smtp.sendgrid.net` for SendGrid)
   - **Port**: `587` (or `465` for SSL)
   - **Username**: (e.g. `resend` for Resend, `apikey` for SendGrid)
   - **Password**: (Your SMTP API key or password)
5. Click **Save Changes**.

---

## Step 2: Paste the Branded Email Templates in Supabase

Navigate to **Supabase Dashboard -> Authentication -> Email Templates**:  
`https://supabase.com/dashboard/project/fjwpzuaaxuwdbwwqfvdp/auth/templates`

Configure the 5 templates below:

### 1. Confirm signup (Email Verification)
- **Subject**: `Verify your email address | StockSense`
- **Template Body (HTML)**: Copy all of [email-templates/verify-email.html](file:///c:/Users/HP/Desktop/StockSense/email-templates/verify-email.html) and paste into the Message Body.
- **Button Text**: `Verify My Email` (already built into template)
- **Confirmation Variable**: `{{ .ConfirmationURL }}` (preserved in template)
- Click **Save Changes**.

### 2. Reset password
- **Subject**: `Reset your password | StockSense`
- **Template Body (HTML)**: Copy all of [email-templates/reset-password.html](file:///c:/Users/HP/Desktop/StockSense/email-templates/reset-password.html) and paste into the Message Body.
- **Button Text**: `Reset Password`
- **Confirmation Variable**: `{{ .ConfirmationURL }}`
- Click **Save Changes**.

### 3. Magic Link
- **Subject**: `Your StockSense login link`
- **Template Body (HTML)**: Copy all of [email-templates/magic-link.html](file:///c:/Users/HP/Desktop/StockSense/email-templates/magic-link.html) and paste into the Message Body.
- **Button Text**: `Sign In to StockSense`
- Click **Save Changes**.

### 4. Invite user
- **Subject**: `You have been invited to StockSense`
- **Template Body (HTML)**: Copy all of [email-templates/invite-user.html](file:///c:/Users/HP/Desktop/StockSense/email-templates/invite-user.html) and paste into the Message Body.
- **Button Text**: `Accept Invitation`
- Click **Save Changes**.

### 5. Change Email Address
- **Subject**: `Confirm email change | StockSense`
- **Template Body (HTML)**: Copy all of [email-templates/change-email.html](file:///c:/Users/HP/Desktop/StockSense/email-templates/change-email.html) and paste into the Message Body.
- **Button Text**: `Confirm Email Change`
- Click **Save Changes**.

---

## Step 3: Verify Site URL & Allowed Redirects

Navigate to **Supabase Dashboard -> Authentication -> URL Configuration**:  
`https://supabase.com/dashboard/project/fjwpzuaaxuwdbwwqfvdp/auth/url-configuration`

Ensure the following URLs are set:

- **Site URL**:
  ```text
  https://stocksense-psi.vercel.app
  ```

- **Redirect URLs (Allowed Redirect URLs)**:
  ```text
  https://stocksense-psi.vercel.app/**
  https://stocksense-psi.vercel.app/auth/verify
  http://localhost:3000/**
  http://localhost:3000/auth/verify
  http://127.0.0.1:3000/**
  http://127.0.0.1:3000/auth/verify
  ```

Click **Save Changes**.

---

## Step 4: Verification Checklist

1. Register a fresh test account on `https://stocksense-psi.vercel.app`.
2. Inspect the received email:
   - **Sender Name**: Displays `StockSense`
   - **Sender Email**: Displays your configured domain (or `noreply@mail.app.supabase.io` if Custom SMTP is pending)
   - **Subject**: `Verify your email address | StockSense`
   - **Layout**: Dark purple header (`#161024`), green accent button (`#10b981`), StockSense logo & tagline (*Know Your Stock. Grow Your Business.*)
   - **CTA Button**: Clicking "Verify My Email" takes the user to `https://stocksense-psi.vercel.app/auth/verify` and successfully activates the account.
