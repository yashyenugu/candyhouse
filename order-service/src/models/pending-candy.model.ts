import mongoose from 'mongoose';
import { getModelForClass, prop, modelOptions, index, ReturnModelType } from '@typegoose/typegoose';

// A candy event whose vendor's user event has not been processed yet. The `user` and `candy` topics
// have no ordering guarantee between them, so the candy waits here until its vendor arrives.
@modelOptions({ schemaOptions: { timestamps: true } })
@index({ appId: 1 }, { unique: true })
@index({ vendor: 1 })
export class PendingCandy {
  readonly _id!: string;

  @prop({ type: String, required: true })
  appId!: string;

  // The vendor's appId (not an ObjectId: the vendor is not in this database yet).
  @prop({ type: String, required: true })
  vendor!: string;

  // The candy event exactly as received.
  @prop({ type: mongoose.SchemaTypes.Mixed, required: true })
  payload!: unknown;
}

// eslint-disable-next-line @typescript-eslint/ban-types
const PendingCandyModel = (mongoose.models.PendingCandy || getModelForClass(PendingCandy)) as ReturnModelType<typeof PendingCandy, {}>;

export default PendingCandyModel;
