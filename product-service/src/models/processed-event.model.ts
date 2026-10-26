import { getModelForClass, prop, modelOptions, index, ReturnModelType } from '@typegoose/typegoose';

const RETENTION_SECONDS = 60 * 60 * 24 * 30;

// One row per applied event id. The unique index is what makes redelivered events a no-op; rows
// expire after 30 days, so redeliveries older than that are not deduplicated.
@modelOptions({ schemaOptions: { timestamps: { createdAt: true, updatedAt: false } } })
@index({ eventId: 1 }, { unique: true })
@index({ createdAt: 1 }, { expireAfterSeconds: RETENTION_SECONDS })
export class ProcessedEvent {
  readonly _id!: string;

  @prop({ type: String, required: true })
  eventId!: string;

  readonly createdAt!: Date;
}

// eslint-disable-next-line @typescript-eslint/ban-types
const ProcessedEventModel = getModelForClass(ProcessedEvent) as ReturnModelType<typeof ProcessedEvent, {}>;

export default ProcessedEventModel;
