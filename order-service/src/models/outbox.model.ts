import mongoose from 'mongoose';
import { getModelForClass, prop, modelOptions, ReturnModelType } from '@typegoose/typegoose';

@modelOptions({ schemaOptions: { timestamps: true } })
export class Outbox {
  readonly _id!: string;

  @prop({ type: String, required: true })
  topic!: string;

  @prop({ type: mongoose.SchemaTypes.Mixed, required: true })
  messages!: unknown;

  // pending | sent
  @prop({ type: String, default: 'pending' })
  status!: string;
}

// eslint-disable-next-line @typescript-eslint/ban-types
const OutboxModel = (mongoose.models.Outbox || getModelForClass(Outbox)) as ReturnModelType<typeof Outbox, {}>;

export default OutboxModel;
