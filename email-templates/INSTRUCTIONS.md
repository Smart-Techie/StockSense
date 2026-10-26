# StockSense Supabase Auth Email Branding & Configuration Guide

Follow these steps in your Supabase Dashboard for project **fjwpzuaaxuwdbwwqfvdp** to complete the branded email and redirect setup.

---

## 1. Configure the Verification Email Template

1. Open your Supabase Dashboard:
   `https://supabase.com/dashboard/project/fjwpzuaaxuwdbwwqfvdp/auth/templates`
2. Under **Email Templates**, select **Confirm signup**.
3. Set the **Subject** line to:
   ```text
   Verify your email address | StockSense
   ```
4. In the **Message Body (HTML)** field, paste the entire contents of [email-templates/verify-email.html](file:///c:/Users/HP/Desktop/StockSense/email-templates/verify-email.html).
5. (Optional) If your plan supports a plain-text fallback, paste the contents of [email-templates/verify-email.txt](file:///c:/Users/HP/Desktop/StockSense/email-templates/verify-email.txt).
6. Click **Save Changes**.

---

## 2. Configure Auth Site URL & Redirect URLs

This is the **root cause** of the "Site can't be reached" error. When a user clicks the verification link in their email, Supabase redirects them to the configured Site URL / Redirect URL. If this is pointing to `http://localhost:3000`, mobile devices and production users will get "Site can't be reached".

1. Go to **Authentication -> URL Configuration** in Supabase:
   `https://supabase.com/dashboard/project/fjwpzuaaxuwdbwwqfvdp/auth/url-configuration`
2. Set **Site URL** to:
   ```text
   https://stocksense-psi.vercel.app
   ```
3. In **Redirect URLs** (Allowed Redirect URLs), add the following URLs:
   ```text
   https://stocksense-psi.vercel.app/**
   https://stocksense-psi.vercel.app/auth/verify
   http://localhost:3000/**
   http://localhost:3000/auth/verify
   http://127.0.0.1:3000/**
   http://127.0.0.1:3000/auth/verify
   ```
4. Click **Save Changes**.

---

## 3. Sender Name & Custom SMTP (Email Provider)

- **Default Supabase Sender**:
  By default, Supabase sends from `noreply@mail.app.supabase.io` with sender name `Supabase`.
  - In **Authentication -> Email Templates**, update the **Sender Name** field to:
    ```text
    StockSense
    ```
- **Custom Sender Domain (e.g. notifications@stocksense.io)**:
  To send from your own domain rather than `@mail.app.supabase.io`, navigate to:
  `https://supabase.com/dashboard/project/fjwpzuaaxuwdbwwqfvdp/settings/auth` -> **SMTP Settings**.
  Toggle **Enable Custom SMTP** and enter credentials from your email service (e.g. Resend, SendGrid, Postmark, or Amazon SES):
  - Sender email: `support@yourdomain.com` or `hello@yourdomain.com`
  - Sender name: `StockSense`
  - Host, Port, Username, Password.
