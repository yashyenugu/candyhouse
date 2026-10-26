import { z } from 'zod';
import CandyModel from '@/models/candy.model';
import PendingCandyModel from '@/models/pending-candy.model';
import { UserModel } from '@/models/user.model';
import { candySchema } from '@/utils/schemas/candy';
import { userSchema } from '@/utils/schemas/user';

type CandyEvent = z.infer<typeof candySchema>;

// A handler must never wait for a message from another topic: the consumer processes one batch at a
// time, so the awaited message would be stuck behind the waiting one. Instead an event whose vendor
// is unknown is parked in PendingCandy and applied when the vendor's user event arrives.

const storeCandy = async (event: CandyEvent, vendorId: string): Promise<void> => {
  const { description, name, photo, price, quantity, appId } = event;
  await CandyModel.findOneAndUpdate({ appId }, { appId, photo, price, name, quantity, description, vendor: vendorId }, { upsert: true });
};

// Apply every candy parked for this vendor, then forget it.
const flushPendingCandies = async (vendorAppId: string, vendorId: string): Promise<void> => {
  const pending = await PendingCandyModel.find({ vendor: vendorAppId });
  for (const parked of pending) {
    await storeCandy(candySchema.parse(parked.payload), vendorId);
    await PendingCandyModel.deleteOne({ _id: parked._id });
  }
};

export const handleUserMessage = async (value: string): Promise<void> => {
  const { appId, balance, email, name, role, totalEarnedCoins, totalRedeemedCoins } = userSchema.parse(JSON.parse(value));
  const user = await UserModel.findOneAndUpdate(
    { appId },
    { balance, email, name, role, totalEarnedCoins, totalRedeemedCoins },
    { upsert: true, new: true },
  );
  await flushPendingCandies(appId, user._id);
};

// Returns true if the candy was stored, false if it was parked waiting for its vendor.
export const handleCandyMessage = async (value: string): Promise<boolean> => {
  const event = candySchema.parse(JSON.parse(value));

  const vendor = await UserModel.findOne({ appId: event.vendor });
  if (vendor) {
    await storeCandy(event, vendor._id);
    return true;
  }

  // Latest event for a candy wins, matching how stored candies are updated.
  await PendingCandyModel.findOneAndUpdate({ appId: event.appId }, { appId: event.appId, vendor: event.vendor, payload: event }, { upsert: true });

  // The vendor may have been stored between the lookup and the park; do not strand the candy.
  const lateVendor = await UserModel.findOne({ appId: event.vendor });
  if (lateVendor) {
    await flushPendingCandies(event.vendor, lateVendor._id);
    return true;
  }
  return false;
};
