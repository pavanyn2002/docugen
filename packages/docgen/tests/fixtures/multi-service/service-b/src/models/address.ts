import mongoose, { Schema } from 'mongoose';
const AddressSchema = new Schema({ country: String });
mongoose.model('Address', AddressSchema);
