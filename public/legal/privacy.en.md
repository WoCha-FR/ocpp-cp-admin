# Privacy Policy

*Last updated: to be completed*

> This document is a generic template. To adapt it to your situation, copy it to `config/legal/privacy.en.md` and edit it.

## Data Controller

This application is operated by **[Operator Name]**.  
Contact: [contact email address]

## Data Collected

### Authentication Data

When authenticating via Google, the following information is transmitted and stored:

- Email address
- Display name
- Google identifier (unique ID)

If you use local authentication (password), a hash of your password is stored. Your password in plain text is never retained.

When a password reset is requested, a one-time token is generated and sent by email. This token is valid for 30 minutes. For initial password setup at account creation, the token is valid for 24 hours. These tokens are never stored in plain text.

### Account Data

The following information is recorded by the application when managing your account:

- Role assigned (administrator, manager, or user) — set by an administrator
- Supervised sites you have access to and your role on each — set by an administrator
- Language preference
- Account creation date
- Date and time of last login

### RFID Tokens and Charging History

If one or more RFID tokens (or other charging identifiers) are assigned to you by an administrator, the following information is recorded and linked to your account:

- Identifier(s) of the token(s) (RFID, code, MAC address, etc.)
- Charging session history initiated with these tokens: chargepoint used, connector, start and end date/time, energy consumed, measured power, stop reason

This data is only recorded when a token is explicitly assigned to you. Sessions initiated without an identified token are not linked to your profile.

### Push Notifications (if enabled)

If you enable push notifications in your browser, the following data is stored:

- Push subscription identifier
- Notification encryption key (provided by your browser)
- Browser user-agent at the time of subscription
- Notification preferences by event type

A history of notifications sent (type, timestamp) is also retained.

### Pushover Notifications (if enabled)

If you configure notifications via Pushover, the following data is stored in your account and transmitted to the Pushover API when notifications are sent:

- Pushover user key
- Pushover device token

Pushover is a third-party service subject to its own privacy policy. Using this feature involves a transfer of data to Pushover's servers.

### Emails Sent by the Application

The application uses an SMTP server to send emails in the following situations:

- Password reset (one-time link, valid for 30 minutes)
- Initial password setup at account creation (valid for 24 hours)
- Notification of addition, removal, suspension, or reactivation of site access
- Event alerts related to supervised chargepoints or charging sessions (if enabled in your preferences)

These emails are sent to the address associated with your account. No data is transmitted to a third-party provider beyond the SMTP relay configured by the operator.

## Purpose of Processing

The data collected is used for the following purposes:

- **Authentication**: verify the identity of authorised users and maintain their session
- **Access management**: control access rights to supervised sites and chargepoints
- **Infrastructure supervision**: manage and monitor OCPP charging stations
- **Notifications**: alert users to events related to chargepoints and charging sessions
- **Access recovery**: enable secure password reset

Your data is not sold, shared with third parties for commercial purposes, or used for profiling or marketing.

## Restricted Access

This application **does not offer self-registration**. Access is granted only by invitation from an authorised administrator or manager. Your data is only processed if you have been expressly invited to use this service.

## Legal Basis

Processing is based on the legitimate interest of the operator in securing access to its EV charging infrastructure management system.

## Retention Period

Your data is retained for as long as your account is active in the application. It is deleted upon your request or at the discretion of the system administrator.

## Your Rights (GDPR)

Under the General Data Protection Regulation (GDPR), you have the following rights:

- **Access**: obtain a copy of your data
- **Rectification**: correct inaccurate data
- **Erasure**: request deletion of your data
- **Objection**: object to the processing

To exercise these rights, contact the system administrator at: [contact email address]

## Cookies and Sessions

The application uses a secure session cookie (`httpOnly`, 24-hour duration) to maintain your authentication. This cookie references a session stored server-side in a local database — no session data is retained in the browser. No tracking or advertising cookies are used.

## Contact

For any questions regarding the protection of your personal data: [contact email address]
