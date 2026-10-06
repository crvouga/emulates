# CareTalk external API (Emulates subset) — operation support

Generated from `openapi.yaml`; do not edit by hand.

- operations in spec: **9**
- supported by the emulator: **9**
- parity enabled: **9**

| operationId | route | emulator | parity | notes |
| --- | --- | --- | --- | --- |
| `ClientLogin` | `POST /externalapi/Auth/client-login` | ✅ supported | ✅ |  |
| `GetForm` | `GET /externalapi/Forms/GetForm/{formName}` | ✅ supported | ✅ |  |
| `SavePatientForm` | `POST /externalapi/Forms/SavePatientForm` | ✅ supported | ⚠️ unsafe (opt-in) |  |
| `SearchForPatient` | `GET /externalapi/Patients/SearchForPatient` | ✅ supported | ✅ |  |
| `ListStates` | `GET /externalapi/States` | ✅ supported | ✅ |  |
| `InsertPatient` | `POST /externalapi/Patients` | ✅ supported | ⚠️ unsafe (opt-in) |  |
| `GetFreeSlots` | `GET /externalapi/PatientAppointments/GetFreeSlots` | ✅ supported | ✅ |  |
| `ScheduleAppointment` | `POST /externalapi/PatientAppointments` | ✅ supported | ⚠️ unsafe (opt-in) |  |
| `GetPatientAppointments` | `GET /externalapi/PatientAppointments/GetPatientAppointmentsByEligibleId/{eligibleId}` | ✅ supported | ✅ |  |
