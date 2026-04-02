const User = {
  useremail: {
    in: ['body'],
    isEmail: { options: { allow_ip_domain: false } },
    normalizeEmail: { options: { gmail_remove_dots: false } },
    trim: true,
    escape: true,
    errorMessage: 'VALIDATION_USER_EMAIL_INVALID',
  },
  password: {
    in: ['body'],
    trim: true,
    isString: true,
    isStrongPassword: { options: { minLength: 8, maxLength: 50 } },
    errorMessage: 'VALIDATION_USER_PASSWORD',
  },
  shortname: {
    in: ['body'],
    matches: { options: /^[a-zA-ZÀ-Ÿ0-9-_ ]*$/ },
    isLength: { options: { min: 2, max: 50 } },
    trim: true,
    escape: true,
    errorMessage: 'VALIDATION_USER_SHORTNAME',
  },
};

const UserUpdate = {
  useremail: {
    in: ['body'],
    isEmail: { options: { allow_ip_domain: false } },
    normalizeEmail: { options: { gmail_remove_dots: false } },
    trim: true,
    escape: true,
    errorMessage: 'VALIDATION_USER_EMAIL_INVALID',
  },
  shortname: {
    in: ['body'],
    matches: { options: /^[a-zA-ZÀ-Ÿ0-9-_ ]*$/ },
    isLength: { options: { min: 2, max: 50 } },
    trim: true,
    escape: true,
    errorMessage: 'VALIDATION_USER_SHORTNAME',
  },
  password: {
    in: ['body'],
    optional: { options: { values: 'falsy' } },
    trim: true,
    isString: true,
    isStrongPassword: { options: { minLength: 8, maxLength: 50 } },
    errorMessage: 'VALIDATION_USER_PASSWORD',
  },
};

const Site = {
  name: {
    in: ['body'],
    matches: { options: /^[a-zA-ZÀ-Ÿ0-9-_ ]*$/ },
    isLength: { options: { min: 5, max: 75 } },
    trim: true,
    escape: true,
    errorMessage: 'VALIDATION_SITE_NAME',
  },
  address: {
    in: ['body'],
    optional: { options: { values: 'falsy' } },
    matches: { options: /^[a-zA-ZÀ-Ÿ0-9-_,. ]*$/ },
    isLength: { options: { min: 5, max: 255 } },
    trim: true,
    escape: true,
    errorMessage: 'VALIDATION_SITE_ADDRESS',
  },
};

const UserSite = {
  useremail: {
    in: ['body'],
    isEmail: { options: { allow_ip_domain: false } },
    normalizeEmail: { options: { gmail_remove_dots: false } },
    trim: true,
    escape: true,
    errorMessage: 'VALIDATION_USER_EMAIL_INVALID',
  },
};

const ChargePoint = {
  identity: {
    in: ['body'],
    matches: { options: /^[A-Z0-9-_]*$/ },
    isLength: { options: { min: 5, max: 45 } },
    trim: true,
    escape: true,
    errorMessage: 'VALIDATION_CHARGEPOINT_IDENTITY',
  },
  name: {
    in: ['body'],
    optional: { options: { nullable: true } },
    matches: { options: /^[a-zA-ZÀ-Ÿ0-9-_ ]*$/ },
    isLength: { options: { min: 5, max: 75 } },
    trim: true,
    escape: true,
    errorMessage: 'VALIDATION_CHARGEPOINT_NAME',
  },
  password: {
    in: ['body'],
    optional: { options: { nullable: true } },
    matches: { options: /^[a-zA-Z0-9]*$/ },
    isLength: { options: { min: 8, max: 16 } },
    trim: true,
    errorMessage: 'VALIDATION_CHARGEPOINT_PASSWORD',
  },
  mode: {
    in: ['body'],
    isInt: true,
    isIn: { options: [[1, 2, 3]] },
    errorMessage: 'VALIDATION_CHARGEPOINT_MODE',
  },
  site_id: {
    in: ['body'],
    isInt: { options: { gt: 0 } },
    errorMessage: 'VALIDATION_CHARGEPOINT_SITE',
  },
  authorized: {
    in: ['body'],
    optional: true,
    isInt: true,
    isIn: { options: [[0, 1]] },
    errorMessage: 'VALIDATION_CHARGEPOINT_AUTHORIZED',
  },
};

const ChargePointSite = {
  site_id: { isInt: { options: { gt: 0 } }, errorMessage: 'VALIDATION_CHARGEPOINT_SITE' },
};

const ConnectorDetails = {
  connector_name: {
    in: ['body'],
    matches: { options: /^[a-zA-ZÀ-Ÿ0-9-_ ]*$/ },
    isLength: { options: { min: 1, max: 50 } },
    trim: true,
    escape: true,
    errorMessage: 'VALIDATION_CONNECTOR_NAME',
  },
  connector_power: {
    in: ['body'],
    isInt: { options: { min: 1, max: 900 } },
    errorMessage: 'VALIDATION_CONNECTOR_POWER',
  },
  connector_type: {
    in: ['body'],
    matches: { options: /^[a-zA-Z0-9-_ ]*$/ },
    trim: true,
    escape: true,
    errorMessage: 'VALIDATION_CONNECTOR_TYPE',
  },
};

const IdTag = {
  id_tag: {
    in: ['body'],
    matches: { options: /^[a-zA-Z0-9]*$/ },
    isLength: { options: { min: 6, max: 20 } },
    trim: true,
    errorMessage: 'VALIDATION_IDTAG_FORMAT',
  },
  user_id: { in: ['body'], optional: { options: { nullable: true } }, isInt: true },
  site_id: { in: ['body'], optional: { options: { nullable: true } }, isInt: true },
  description: {
    in: ['body'],
    optional: { options: { values: 'falsy' } },
    isLength: { options: { min: 1, max: 255 } },
    trim: true,
    escape: true,
    errorMessage: 'VALIDATION_IDTAG_DESCRIPTION',
  },
  expiry_date: {
    in: ['body'],
    optional: { options: { values: 'falsy' } },
    isISO8601: true,
    errorMessage: 'VALIDATION_IDTAG_EXPIRY_DATE',
  },
  active: { in: ['body'], optional: true, isInt: true, isIn: { options: [[0, 1]] } },
};

const UserProfile = {
  useremail: {
    in: ['body'],
    optional: { options: { values: 'falsy' } },
    isEmail: { options: { allow_ip_domain: false } },
    normalizeEmail: { options: { gmail_remove_dots: false } },
    trim: true,
    escape: true,
    errorMessage: 'VALIDATION_USER_EMAIL_INVALID',
  },
  shortname: {
    in: ['body'],
    optional: { options: { values: 'falsy' } },
    matches: { options: /^[a-zA-ZÀ-Ÿ0-9-_ ]*$/ },
    isLength: { options: { min: 2, max: 50 } },
    trim: true,
    escape: true,
    errorMessage: 'VALIDATION_USER_SHORTNAME',
  },
  currentPassword: {
    in: ['body'],
    optional: { options: { values: 'falsy' } },
    isLength: { options: { min: 1 } },
    errorMessage: 'VALIDATION_USER_CURRENT_PASSWORD',
  },
  newPassword: {
    in: ['body'],
    optional: { options: { values: 'falsy' } },
    isStrongPassword: { options: { minLength: 8, maxLength: 50 } },
    trim: true,
    isString: true,
    errorMessage: 'VALIDATION_USER_PASSWORD',
  },
  langue: {
    in: ['body'],
    optional: { options: { values: 'falsy' } },
    matches: { options: /^[a-z]{2}$/ },
    trim: true,
    errorMessage: 'VALIDATION_USER_LANG',
  },
  ntif_pushuser: {
    in: ['body'],
    optional: { options: { values: 'falsy' } },
    matches: { options: /^[a-zA-Z0-9]*$/ },
    isLength: { options: { min: 30, max: 30 } },
    trim: true,
    errorMessage: 'VALIDATION_PUSHOVER_USER',
  },
  ntif_pushtokn: {
    in: ['body'],
    optional: { options: { values: 'falsy' } },
    matches: { options: /^[a-zA-Z0-9]*$/ },
    isLength: { options: { min: 30, max: 30 } },
    trim: true,
    errorMessage: 'VALIDATION_PUSHOVER_TOKEN',
  },
};

const ForgotPassword = {
  useremail: {
    in: ['body'],
    isEmail: { options: { allow_ip_domain: false } },
    normalizeEmail: { options: { gmail_remove_dots: false } },
    trim: true,
    escape: true,
    errorMessage: 'VALIDATION_USER_EMAIL_INVALID',
  },
};

const ResetPassword = {
  token: {
    in: ['body'],
    matches: { options: /^[a-f0-9]{64}$/ },
    trim: true,
    errorMessage: 'VALIDATION_PASSWORD_RESET_TOKEN',
  },
  newPassword: {
    in: ['body'],
    isStrongPassword: { options: { minLength: 8, maxLength: 50 } },
    trim: true,
    isString: true,
    errorMessage: 'VALIDATION_USER_PASSWORD',
  },
};

const ResendSetupPassword = {
  userId: { in: ['body'], isInt: { options: { gt: 0 } }, errorMessage: 'VALIDATION_USER_ID' },
};

const Login = {
  useremail: {
    in: ['body'],
    isEmail: { options: { allow_ip_domain: false } },
    normalizeEmail: { options: { gmail_remove_dots: false } },
    trim: true,
    errorMessage: 'VALIDATION_USER_EMAIL_INVALID',
  },
  password: {
    in: ['body'],
    isString: true,
    isLength: { options: { min: 8, max: 200 } },
    trim: true,
    errorMessage: 'VALIDATION_USER_PASSWORD',
  },
};

const IdParam = {
  id: { in: ['params'], isInt: { options: { gt: 0 } }, toInt: true, errorMessage: 'VALIDATION_ID' },
};

const TransactionIdParam = {
  transactionId: {
    in: ['params'],
    isInt: { options: { gt: 0 } },
    toInt: true,
    errorMessage: 'VALIDATION_TRANSACTION_ID',
  },
};

const SiteIdParam = {
  siteId: {
    in: ['params'],
    isInt: { options: { gt: 0 } },
    toInt: true,
    errorMessage: 'VALIDATION_SITE_ID',
  },
};

const SiteUserParams = {
  siteId: {
    in: ['params'],
    isInt: { options: { gt: 0 } },
    toInt: true,
    errorMessage: 'VALIDATION_SITE_ID',
  },
  userId: {
    in: ['params'],
    isInt: { options: { gt: 0 } },
    toInt: true,
    errorMessage: 'VALIDATION_USER_ID',
  },
};

const UserRole = {
  role: {
    in: ['body'],
    isIn: { options: [['admin', 'manager', 'user']] },
    errorMessage: 'VALIDATION_USER_ROLE',
  },
};

const UserSitesAssignment = {
  sites: {
    in: ['body'],
    isArray: { options: { min: 0, max: 500 } },
    errorMessage: 'VALIDATION_USER_SITES_ARRAY',
  },
  'sites.*.site_id': {
    in: ['body'],
    isInt: { options: { gt: 0 } },
    toInt: true,
    errorMessage: 'VALIDATION_SITE_ID',
  },
  'sites.*.role': {
    in: ['body'],
    isIn: { options: [['manager', 'user']] },
    errorMessage: 'VALIDATION_SITE_ROLE',
  },
  'sites.*.authorized': {
    in: ['body'],
    isIn: { options: [[0, 1, true, false]] },
    errorMessage: 'VALIDATION_AUTHORIZED',
  },
};

const SiteUserPatch = {
  authorized: {
    in: ['body'],
    optional: true,
    isIn: { options: [[0, 1, true, false]] },
    errorMessage: 'VALIDATION_AUTHORIZED',
  },
  role: {
    in: ['body'],
    optional: true,
    isIn: { options: [['manager', 'user']] },
    errorMessage: 'VALIDATION_SITE_ROLE',
  },
};

const StartCharge = {
  chargepoint_id: {
    in: ['body'],
    isInt: { options: { gt: 0 } },
    toInt: true,
    errorMessage: 'VALIDATION_CHARGEPOINT_ID',
  },
  connector_id: {
    in: ['body'],
    isInt: { options: { gt: 0 } },
    toInt: true,
    errorMessage: 'VALIDATION_CONNECTOR_ID',
  },
};

const StopCharge = {
  chargepoint_id: {
    in: ['body'],
    isInt: { options: { gt: 0 } },
    toInt: true,
    errorMessage: 'VALIDATION_CHARGEPOINT_ID',
  },
  transaction_id: {
    in: ['body'],
    isInt: { options: { gt: 0 } },
    toInt: true,
    errorMessage: 'VALIDATION_TRANSACTION_ID',
  },
};

const TransactionsQuery = {
  chargepoint_id: {
    in: ['query'],
    optional: true,
    isInt: { options: { gt: 0 } },
    toInt: true,
    errorMessage: 'VALIDATION_CHARGEPOINT_ID',
  },
  site_id: {
    in: ['query'],
    optional: true,
    isInt: { options: { gt: 0 } },
    toInt: true,
    errorMessage: 'VALIDATION_SITE_ID',
  },
  status: {
    in: ['query'],
    optional: true,
    isIn: { options: [['Active', 'Completed', 'Stopped', 'Error']] },
    errorMessage: 'VALIDATION_TRANSACTION_STATUS',
  },
  from: { in: ['query'], optional: true, isISO8601: true, errorMessage: 'VALIDATION_DATE_FROM' },
  to: { in: ['query'], optional: true, isISO8601: true, errorMessage: 'VALIDATION_DATE_TO' },
  limit: {
    in: ['query'],
    optional: true,
    isInt: { options: { min: 1, max: 200 } },
    toInt: true,
    errorMessage: 'VALIDATION_LIMIT',
  },
};

const UserTransactionsQuery = {
  status: {
    in: ['query'],
    optional: true,
    isIn: { options: [['Active', 'Completed', 'Stopped', 'Error']] },
    errorMessage: 'VALIDATION_TRANSACTION_STATUS',
  },
  from: { in: ['query'], optional: true, isISO8601: true, errorMessage: 'VALIDATION_DATE_FROM' },
  to: { in: ['query'], optional: true, isISO8601: true, errorMessage: 'VALIDATION_DATE_TO' },
};

const OcppMessagesQuery = {
  chargepoint_id: {
    in: ['query'],
    optional: true,
    isInt: { options: { gt: 0 } },
    toInt: true,
    errorMessage: 'VALIDATION_CHARGEPOINT_ID',
  },
  origin: {
    in: ['query'],
    optional: true,
    isIn: { options: [['csms', 'chargepoint']] },
    errorMessage: 'VALIDATION_OCPP_ORIGIN',
  },
  message_type: {
    in: ['query'],
    optional: true,
    isIn: { options: [['CALL', 'CALLRESULT', 'CALLERROR']] },
    errorMessage: 'VALIDATION_OCPP_MESSAGE_TYPE',
  },
  action: {
    in: ['query'],
    optional: true,
    isString: true,
    isLength: { options: { min: 1, max: 64 } },
    trim: true,
    errorMessage: 'VALIDATION_OCPP_ACTION',
  },
};

const IdTagEventsQuery = {
  chargepoint_id: {
    in: ['query'],
    optional: true,
    isInt: { options: { gt: 0 } },
    toInt: true,
    errorMessage: 'VALIDATION_CHARGEPOINT_ID',
  },
  id_tag: {
    in: ['query'],
    optional: true,
    matches: { options: /^[a-zA-Z0-9]*$/ },
    isLength: { options: { min: 6, max: 20 } },
    trim: true,
    errorMessage: 'VALIDATION_IDTAG_FORMAT',
  },
  status: {
    in: ['query'],
    optional: true,
    isIn: { options: [['Accepted', 'Blocked', 'Expired', 'Invalid']] },
    errorMessage: 'VALIDATION_IDTAG_STATUS',
  },
  limit: {
    in: ['query'],
    optional: true,
    isInt: { options: { min: 1, max: 200 } },
    toInt: true,
    errorMessage: 'VALIDATION_LIMIT',
  },
};

const OcppCommand = {
  method: {
    in: ['body'],
    isIn: {
      options: [
        [
          'CancelReservation',
          'ChangeAvailability',
          'ChangeConfiguration',
          'ClearCache',
          'ClearChargingProfile',
          'DataTransfer',
          'GetCompositeSchedule',
          'GetConfiguration',
          'GetDiagnostics',
          'GetLocalListVersion',
          'RemoteStartTransaction',
          'RemoteStopTransaction',
          'ReserveNow',
          'Reset',
          'SendLocalList',
          'SetChargingProfile',
          'TriggerMessage',
          'UnlockConnector',
          'UpdateFirmware',
        ],
      ],
    },
    errorMessage: 'VALIDATION_OCPP_METHOD',
  },
  params: { in: ['body'], optional: true, isObject: true, errorMessage: 'VALIDATION_OCPP_PARAMS' },
};

const ChargepointConfigUpdate = {
  key: {
    in: ['params'],
    isString: true,
    isLength: { options: { min: 1, max: 64 } },
    matches: { options: /^[a-zA-Z0-9_.-]+$/ },
    errorMessage: 'VALIDATION_CONFIG_KEY',
  },
  value: {
    in: ['body'],
    isString: true,
    isLength: { options: { min: 1, max: 1024 } },
    errorMessage: 'VALIDATION_CONFIG_VALUE',
  },
};

const InitConfig = {
  key: {
    in: ['body'],
    isString: true,
    isLength: { options: { min: 1, max: 64 } },
    matches: { options: /^[a-zA-Z0-9_.-]+$/ },
    errorMessage: 'VALIDATION_CONFIG_KEY',
  },
  value: {
    in: ['body'],
    isString: true,
    isLength: { options: { min: 1, max: 1024 } },
    errorMessage: 'VALIDATION_CONFIG_VALUE',
  },
};

const InitConfigUpdate = {
  value: {
    in: ['body'],
    isString: true,
    isLength: { options: { min: 1, max: 1024 } },
    optional: { options: { nullable: true } },
    errorMessage: 'VALIDATION_CONFIG_VALUE',
  },
  enabled: {
    in: ['body'],
    isBoolean: true,
    toBoolean: true,
    optional: { options: { nullable: true } },
  },
};

const NotificationPreferences = {
  preferences: {
    in: ['body'],
    isArray: { options: { min: 0, max: 200 } },
    errorMessage: 'VALIDATION_PREF_ARRAY',
  },
  'preferences.*.event_type': {
    in: ['body'],
    isString: true,
    isLength: { options: { min: 1, max: 64 } },
    trim: true,
    errorMessage: 'VALIDATION_PREF_EVENT',
  },
  'preferences.*.channel': {
    in: ['body'],
    isIn: { options: [['email', 'pushover', 'webpush']] },
    errorMessage: 'VALIDATION_PREF_CHANNEL',
  },
  'preferences.*.enabled': {
    in: ['body'],
    isIn: { options: [[0, 1, true, false]] },
    errorMessage: 'VALIDATION_PREF_ENABLED',
  },
};

const PushSubscribe = {
  'subscription.endpoint': {
    in: ['body'],
    isURL: true,
    isLength: { options: { min: 1, max: 2048 } },
    errorMessage: 'VALIDATION_PUSH_ENDPOINT',
  },
  'subscription.keys.p256dh': {
    in: ['body'],
    isString: true,
    isLength: { options: { min: 20, max: 512 } },
    errorMessage: 'VALIDATION_PUSH_P256DH',
  },
  'subscription.keys.auth': {
    in: ['body'],
    isString: true,
    isLength: { options: { min: 8, max: 128 } },
    errorMessage: 'VALIDATION_PUSH_AUTH',
  },
};

const PushUnsubscribe = {
  endpoint: {
    in: ['body'],
    optional: true,
    isURL: true,
    isLength: { options: { min: 1, max: 2048 } },
    errorMessage: 'VALIDATION_PUSH_ENDPOINT',
  },
};

const PendingChargepointIdentity = {
  identity: {
    in: ['params'],
    matches: { options: /^[A-Z0-9-_]*$/ },
    isLength: { options: { min: 5, max: 45 } },
    trim: true,
    errorMessage: 'VALIDATION_CHARGEPOINT_IDENTITY',
  },
};

const NotificationsLogQuery = {
  limit: {
    in: ['query'],
    optional: true,
    isInt: { options: { min: 1, max: 200 } },
    toInt: true,
    errorMessage: 'VALIDATION_LIMIT',
  },
};

module.exports = {
  User,
  UserUpdate,
  Site,
  UserSite,
  ChargePoint,
  ChargePointSite,
  ConnectorDetails,
  IdTag,
  UserProfile,
  ForgotPassword,
  ResetPassword,
  ResendSetupPassword,
  Login,
  IdParam,
  TransactionIdParam,
  SiteIdParam,
  SiteUserParams,
  UserRole,
  UserSitesAssignment,
  SiteUserPatch,
  StartCharge,
  StopCharge,
  TransactionsQuery,
  UserTransactionsQuery,
  OcppMessagesQuery,
  IdTagEventsQuery,
  OcppCommand,
  ChargepointConfigUpdate,
  InitConfig,
  InitConfigUpdate,
  NotificationPreferences,
  PushSubscribe,
  PushUnsubscribe,
  PendingChargepointIdentity,
  NotificationsLogQuery,
};
