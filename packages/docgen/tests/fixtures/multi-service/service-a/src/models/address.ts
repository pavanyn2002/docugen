import mongoose, { Schema } from 'mongoose';
const AddressSchema = new Schema({ city: String });
mongoose.model('Address', AddressSchema);
