import mongoose, { Schema } from 'mongoose';
const EnquirySchema = new Schema({ message: String });
mongoose.model('Enquiry', EnquirySchema);
