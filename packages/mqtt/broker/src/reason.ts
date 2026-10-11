/**
 * MQTT 5.0 reason codes (2.4), by the specification's names.
 * https://docs.oasis-open.org/mqtt/mqtt/v5.0/os/mqtt-v5.0-os.html#_Toc3901031
 */
export const ReasonCode = {
  /** Also "Normal disconnection" and "Granted QoS 0". */
  Success: 0x00,
  GrantedQoS1: 0x01,
  GrantedQoS2: 0x02,
  NoMatchingSubscribers: 0x10,
  NoSubscriptionExisted: 0x11,
  UnspecifiedError: 0x80,
  MalformedPacket: 0x81,
  ProtocolError: 0x82,
  ImplementationSpecificError: 0x83,
  UnsupportedProtocolVersion: 0x84,
  ClientIdentifierNotValid: 0x85,
  BadUserNameOrPassword: 0x86,
  NotAuthorized: 0x87,
  ServerUnavailable: 0x88,
  ServerBusy: 0x89,
  Banned: 0x8a,
  ServerShuttingDown: 0x8b,
  BadAuthenticationMethod: 0x8c,
  KeepAliveTimeout: 0x8d,
  SessionTakenOver: 0x8e,
  TopicFilterInvalid: 0x8f,
  TopicNameInvalid: 0x90,
  PacketIdentifierInUse: 0x91,
  PacketIdentifierNotFound: 0x92,
  ReceiveMaximumExceeded: 0x93,
  TopicAliasInvalid: 0x94,
  PacketTooLarge: 0x95,
  MessageRateTooHigh: 0x96,
  QuotaExceeded: 0x97,
  AdministrativeAction: 0x98,
  PayloadFormatInvalid: 0x99,
  RetainNotSupported: 0x9a,
  QoSNotSupported: 0x9b,
  UseAnotherServer: 0x9c,
  ServerMoved: 0x9d,
  SharedSubscriptionsNotSupported: 0x9e,
  ConnectionRateExceeded: 0x9f,
  MaximumConnectTime: 0xa0,
  SubscriptionIdentifiersNotSupported: 0xa1,
  WildcardSubscriptionsNotSupported: 0xa2,
} as const

export type ReasonCodeName = keyof typeof ReasonCode
